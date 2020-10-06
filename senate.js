const SENATE_URL = "https://www.senate.gov/legislative/votes_new.htm";
const LOG_FILE_NAME = 'senate.txt';
const PAGE_DELAY = 750;
const CLICK_DELAY = 750;
const ERROR_SCREENSHOT_URI = `./screenshots/errors`;

var xml2js = require('xml2js');
var fs = require('fs');
var { performance } = require('perf_hooks');

var XMLParser = new xml2js.Parser({
    explicitArray: false,
    explicitRoot: false,
    ignoreAttrs: true
});


var logStream;
var DEBUG;
async function parseSenate(playwright, db, opts = { clearDB: true, debug: true, withBrowser: false}) {
    DEBUG = opts.debug;
    if (opts.clearDB) {
        await db.clearDB();
    }
    if (DEBUG) {
        fs.truncate(LOG_FILE_NAME, 0, function () { });
        logStream = fs.createWriteStream(LOG_FILE_NAME, { flags: 'a' });
    }
    
    printMsg(`PARSING SENATE STARTED`);

    // Open a Chromium browser. We use headless: false
    // to be able to watch what's going on.
    try {
        const browser = await playwright.chromium.launch({
            headless: !opts.withBrowser,
            acceptDownloads: true
        });
        // Open a new page / tab in the browser.
        var page = await browser.newPage();

        // TODO if the url we're visiting isn't the senate url, we
        // need a circumvent method. This circumvent method will take
        // us thru the clicks required to get back to the senate url 
        // the senate.gov errors randomly (maybe a rate limit)

        // need to get the past roll call options up front to determine 
        // how many loops
        await goto(page, SENATE_URL);
        const querySelector = `form[name="PastVotes"] select`;
        // playwright functions sometimes error randomly
        // use the query selector on the page to get the drop down
        var pastRollCallVoteSelectEl = await page.waitForFunction((obj) => {
            return document.querySelector(obj.querySelector);
        }, {
            querySelector
        });
        var pastRollCallOptions = (await pastRollCallVoteSelectEl.$$('option')).slice(1);

        // create a browser context to open the pages
        var summaryBrowserContext = await browser.newContext();
        try {
            // each loop creates a page
            for (let i = 0; i < pastRollCallOptions.length; i++){
                let p = await summaryBrowserContext.newPage();
                await goto(p, SENATE_URL);
                // regrab the select and its options
                // playwright kills the references to the items sometimes
                // probably could keep the page var open to make it work
                let select = await p.waitForFunction((obj) => {
                    return document.querySelector(obj.querySelector);
                }, {
                    querySelector
                });
                let options = (await select.$$('option')).slice(1);
                let opt = options[i];
                let selectValue = await opt.getAttribute('value');
                // get existing summaries based on url of the select value
                let existingSummaries = await db.getSummariesByUrl(selectValue);
                let v = await opt.innerHTML();
                printMsg(`OPTION SUMMARY STARTING: ${v}`);
                // get summary list for each select option
                let results = await parseIndividualSummaryYear(p, select, selectValue, existingSummaries);
                printMsg(`WRITING TO RESULT DB`);
                db.bulkCreateSummary(results);
                printMsg(`OPTION SUMMARY ENDING: ${v}`);
                await p.close();
            }
            printMsg(`CREATING TALLIES`);
            // create new browser context just for tallies
            var tallyBrowserContext = await browser.newContext();
            var summaries = await db.getSummaries();
            printMsg(`# of Summaries: ${summaries.length}`);

            var totalTallyPerfStart = performance.now();
            // for each summary get list of member votes
            for (let i = 0; i < summaries.length; i++) {
                let summary = summaries[i];
                let p = await tallyBrowserContext.newPage();
                var memberVotes = await parseIndividualVotes(p, summary);
                printMsg(`Vote Results: ${JSON.stringify(memberVotes)}`);
                db.bulkCreateTally(memberVotes);
                await p.close();
            }
            var totalTallyPerfEnd = performance.now();
            var perfMsg = `Took ${totalTallyPerfEnd - totalTallyPerfStart}ms to create tallies`;
            console.log(perfMsg);
            printMsg(perfMsg);
        } catch (err) {
            throw err;
        }

        // Turn off the browser to clean up after ourselves.
        await summaryBrowserContext.close();
        await tallyBrowserContext.close();
        await browser.close();

        if (logStream) {
            // ending log stream
            logStream.end();
        }
        return {
            payload: {
                msg: 'completed'
            }
        };
    } catch (err) {
        printMsg('PARSING SENATE ERROR');
        return {
            err,
            payload: null
        };
    }
    printMsg('PARSING SENATE ENDING');
}
async function parseIndividualSummaryYear(page, selectEl, selectValue, existingSummaries) {
    try {
        const xmlSelector = 'webkit-xml-viewer-source-xml';
        printMsg(`parseIndividualSummaryYear Parameters: \n Page: ${page.toString()} \n selectEl: ${selectEl.toString()} \n selectValue: ${selectValue}`);
        await selectEl.selectOption(selectValue);
        printMsg(`WAITING FOR SUMMARY PAGE LOAD - LINE 75`);
        await page.waitForEvent('load');
        var xmlLink = await page.$(`a[href$=".xml"]`);
        // TODO if condition on the xmlLink if it exists
        // log the urls where the xml link doesn't exist, maybe store to db?
        printMsg(`CLICKING XML LINK FOR SUMMARY`);
        await click(xmlLink);
        printMsg(`WAITING FOR SUMMARY XML PAGE LOAD`);
        var divXMLContent = await page.waitForFunction((obj) => {
            return document.getElementById(obj.xmlSelector);
        }, {
            xmlSelector
        });
        printMsg(`PARSING SUMMARY XML CONTENT`);
        var xmlContent = await divXMLContent.innerHTML();
        var { congress, session, congress_year, votes } = await XMLParser.parseStringPromise(xmlContent);

        var summaries = votes.vote.map(vote => {
            return {
                congress,
                session,
                congressYear: congress_year,
                issue: getIssueNumber(vote),
                title: vote.title,
                voteDate: vote.vote_date,
                voteNumber: vote.vote_number,
                url: selectValue
            };
        });
        if (existingSummaries.length == 0) {
            return summaries;
        }
        var highestVoteNumber = getMaxVoteNumber(existingSummaries);

        // only return the summaries after the highest vote number
        return summaries.filter(function newSummaryFilter(summary) {
            return summary.voteNumber > highestVoteNumber;
        });
    } catch (err) {
        var timestamp = new Date();
        await page.screenshot({ path: `${ERROR_SCREENSHOT_URI}/parseIndividualSummaryYear/${timestamp.toString()}.png`});
        printMsg(`ERROR PARSING INDIVIDUAL SUMMARY: ${err}`);
        throw err;
    }
}
async function parseIndividualVotes (page, summary) {
    const xmlSelector = 'webkit-xml-viewer-source-xml';
    try {
        let url = `https://www.senate.gov/legislative/LIS/roll_call_lists/roll_call_vote_cfm.cfm?congress=${summary.congress}&session=${summary.session}&vote=${summary.voteNumber}`;
        printMsg(`LOADING VOTE PAGE: ${summary.voteNumber}`);
        await goto(page, url);
        printMsg(`URL FOR VOTE: ${page.url()}`);
        var xmlLink = await page.$(`a[href$=".xml"]`);
        // TODO if condition on the xmlLink if it exists
        // log the urls where the xml link doesn't exist, maybe store to db?
        printMsg(`CLICKING XML LINK FOR VOTE DETAILS`);
        await click(xmlLink);
        // the xml is hidden on the page so can't use
        // typical selector, use document function
        var divXMLContent = await page.waitForFunction((obj) => {
            return document.getElementById(obj.xmlSelector);
        }, {
            xmlSelector
        });
        printMsg(`PARSING VOTE DETAILS XML CONTENT`);
        xmlContent = await divXMLContent.innerHTML();
        let { members } = await XMLParser.parseStringPromise(xmlContent);
        return members.member.map(function serializeMember(member) {
            return {
                issue: summary.issue,
                name: member.first_name+' '+ member.last_name,
                party: member.party,
                state: member.state,
                title: summary.title,
                voteCast: member.vote_cast
            };
        });
    } catch (err) {
        // do nothing here because we want to parse as much as possible
        // going to log the error however
        // TODO create db log table for silent errors
        var timestamp = new Date();
        var path = `${ERROR_SCREENSHOT_URI}/parseIndividualVotes/${timestamp.toString()}.png`;
        await page.screenshot({ path });
        printMsg(`ERROR PARSING VOTE: ${err}`);
        printMsg(`Screenshot stored: ${path}`);
    }
    return [];
}
function getIssueNumber (vote) {
    if (vote.issue == undefined) {
        return '';
    }
    if (typeof vote.issue == 'object') {
        if (vote.issue.A != undefined) {
            return vote.issue.A;
        }
        return JSON.stringify(vote.issue);
    }
    return vote.issue;
}
function getMaxVoteNumber (summaries) {
    return Math.max.apply(Math, summaries.map(function (summary) { return parseInt(summary.voteNumber, 10); }));
}
function printMsg (msg) {
    if (DEBUG) {
        logStream.write(`==== ${msg} ==== \n`);
    }
}
function writeJSON(fileName, json) {
    return new Promise ((resolve, _) => {
        fs.writeFile(fileName, JSON.stringify(json), (err) => resolve(err));
    });
}

// implement timeouts on playwright actions
// prevent any rate limiting
function goto (page, url) {
    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            try {
                await page.goto(url);
                resolve();
            } catch (err) {
                reject(err);
            }
        }, PAGE_DELAY);
    });
}
function click (item) {
    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            try {
                await item.click();
                resolve();
            } catch (err) {
                reject(err);
            }
        }, CLICK_DELAY);
    });
}
module.exports = parseSenate;