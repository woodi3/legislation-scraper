const mongoose = require('mongoose');

function connect (connStr) {
    mongoose.connect(connStr, { useNewUrlParser: true, useUnifiedTopology: true });
    return mongoose.connection;
}   

const voteSummarySchema = new mongoose.Schema({
    congress: String,
    congressYear: String,
    issue: String,
    session: String,
    title: String,
    voteNumber: String,
    voteDate: String,
    url: String
});
const tallySchema = new mongoose.Schema({
    issue: String,
    name: String,
    party: String,
    state: String,
    title: String,
    voteCast: String
});

const VoteSummary = mongoose.model('VoteSummary', voteSummarySchema);
const Tally = mongoose.model('Tally', tallySchema);

function getSummariesByUrl (url) {
    return VoteSummary.find({url}).exec();
}
function getSummaries () {
    return VoteSummary.find({}).exec();
}
function getTalliesByName (name, projections = null, opts = null) {
    return Tally.find({name}, projections, opts).exec();
}

function createSummary (obj) {
    var summary = new VoteSummary(obj);
    return new Promise((resolve, reject) => {
        summary.save(function(err, doc) {
            if (err) reject(err);

            resolve(doc);
        });
    });
}
function bulkCreateSummary (objs) {
    return new Promise ((resolve, reject) => {
        VoteSummary.insertMany(objs, function (err, docs) {
            if (err) reject(err);
            resolve(docs);
        });
    });
}
function createTally(obj) {
    var tally = new Tally(obj);
    return new Promise((resolve, reject) => {
        tally.save(function (err, doc) {
            if (err) reject(err);

            resolve(doc);
        });
    });
}
function bulkCreateTally(objs) {
    return new Promise((resolve, reject) => {
        Tally.insertMany(objs, function (err, docs) {
            if (err) reject(err);
            resolve(docs);
        });
    });
}
function clearDB () {
    return Promise.all([
        Tally.deleteMany({}).exec(),
        VoteSummary.deleteMany({}).exec()
    ]);
}

module.exports = {
    bulkCreateSummary,
    bulkCreateTally,
    clearDB,
    connect,
    createSummary,
    createTally,
    getSummaries,
    getSummariesByUrl,
    getTalliesByName
}