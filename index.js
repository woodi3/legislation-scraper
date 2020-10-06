require('dotenv').config();
const argv = require('yargs').argv;
const playwright = require('playwright');
const config = require('./config');
const db = require('./db');
const parseSenate = require('./senate');
const runningOpts = {
    debug: argv.debug,
    withBrowser: argv.withBrowser || argv.w,
    clearDB: argv.clearDB
};

async function main() {

    const dbConnection = db.connect(config.DB_CONN_STR);
    dbConnection.on('error', function handleDBError(err) {
        console.log(`Connection error: ${err}`);
    });
    dbConnection.once('open', async function onDBConnected () {
        var { err, payload } = await parseSenate(playwright, db, runningOpts);
        if (err == undefined) {
            console.log(payload);
        } else {
            console.log(err);
        }
    });
}

main();