// trafficSheet.js
// ------------------------------------------------------------------
//
// created: Tue Aug  7 14:42:00 2018
// last saved: <2018-August-08 08:53:52>
//

/* jshint esversion: 6, node: true */
/* global process, console, Buffer */

'use strict';

const request      = require('request'),
      urljoin      = require('url-join'),
      sprintf      = require('sprintf-js').sprintf,
      shajs        = require('sha.js'),
      opn          = require('opn'),
      {google}     = require('googleapis'),
      fs           = require('fs'),
      path         = require('path'),
      Getopt       = require('node-getopt'),
      readline     = require('readline'),
      readlineSync = require('readline-sync'),
      merge        = require('merge'),
      async        = require('async'),
      netrc        = require('netrc')(),
      dateFormat   = require('dateformat'),
      version      = '20180808-0850',
      mgmtServer   = 'https://api.enterprise.apigee.com',
      SCOPES = ['https://www.googleapis.com/auth/spreadsheets'],
      defaults     = {
        dirs : {
          cache : 'cache',
          output : 'output'
        }
      },
    getopt = new Getopt([
      ['o' , 'org=ARG', 'required. name of the Edge organization'],
      ['u' , 'username=ARG', 'optional. username for authenticating to Edge'],
      ['n' , 'netrc', 'optional. specify in lieu of username to rely on .netrc for credentials.'],
      ['y' , 'year=ARG', 'optional. specify a 4-digit year. Default: the current year.'],
      ['v' , 'verbose', 'optional. verbose output.'],
      ['S' , 'sheet', 'optional. create a Google Sheet with the data. Default: emit .csv file.'],
      ['N' , 'nocache', 'optional. do not use cached data; retrieve from stats API']
    ]).bindHelp();

function handleError(e) {
  if (e) {
    console.log('Error: ' + e);
    process.exit(1);
  }
}

function memoize( fn ) {
  return function () {
    var args = Array.prototype.slice.call(arguments),
        hash = "",
        i = args.length,
        currentArg = null;
    while (i--) {
      currentArg = args[i];
      hash += (currentArg === Object(currentArg)) ?
        JSON.stringify(currentArg) : currentArg;
    }
    if ( ! fn.memoize) { fn.memoize = {}; }
    return (hash in fn.memoize) ? fn.memoize[hash] :
      fn.memoize[hash] = fn.apply(this, args);
  };
}

function utcOffset_apigeeTimeFormat(date) {
  var s = dateFormat(date, "isoUtcDateTime");
  s = s.slice(0, -4);
  return s.slice(-5);
}

function addOneDay(date){
  date.setDate(date.getDate() + 1);
  return date;
}

function getTimeRange(start, end) {
  start = dateFormat(start, 'mm/dd/yyyy') + ' ' + utcOffset_apigeeTimeFormat(start);
  end = dateFormat(end, 'mm/dd/yyyy') + ' ' + utcOffset_apigeeTimeFormat(end);
  return start + '~' + end;
}

function base64Encode(s) {
  return new Buffer.from(s).toString('base64');
}

const getBasicAuthHeader = memoize(function(mgmtServer) {
        if (opt.options.netrc) {
          var mgmtUrl = require('url').parse(mgmtServer);
          if ( ! netrc[mgmtUrl.hostname]) {
            throw new Error("there is no entry for the management server in in the .netrc file.");
          }
          return 'Basic ' + base64Encode(netrc[mgmtUrl.hostname].login + ':' + netrc[mgmtUrl.hostname].password);
        }

        var username = opt.options.username;
        if ( !username ) {
           username = readlineSync.question(' USER NAME  : ');
        }
        var password = readlineSync.question(' Password for ' + username + ' : ', {hideEchoBack: true});
        return 'Basic ' + base64Encode(username + ':' + password);
      });

function getRequestOptions() {
  return {
    method : 'GET',
    headers : {
      authorization : getBasicAuthHeader(mgmtServer),
      accept : 'application/json'
    }
  };
}

function getEnvironments(cb) {
  var requestOptions = merge(getRequestOptions(), {
        url : urljoin(mgmtServer, 'v1/o', opt.options.org)
      });

  console.log('GET "%s"', requestOptions.url);
  request(requestOptions, function(error, response, body){
    var result = JSON.parse(body);
    cb(null, result.environments);
  });
}

function retrieveData(options, cb) {
  // time curl -n "$mgmtserver/v1/o/$ORG/e/$ENV/stats/apis?select=sum(message_count)&timeRange=01/01/2018%2000:00~08/01/2018%2000:00&timeUnit=month"
  var query = sprintf('?select=sum(message_count)&timeUnit=month&timeRange=%s',
                      getTimeRange(options.startTime, options.endTime));

  var requestOptions = merge(getRequestOptions(), {
        url : urljoin(mgmtServer, 'v1/o', options.organization, 'e', options.environment, 'stats/apis') + query
      });

  console.log('GET "%s"', requestOptions.url);
  var today = dateFormat(new Date(), "yyyymmdd");
  var sha = shajs('sha256').update(JSON.stringify(requestOptions))
    .update(today)
    .digest('hex');

  var cacheFileName = path.join(defaults.dirs.cache, sha + '--' + today + '.json');
  if ( ! options.nocache && fs.existsSync(cacheFileName)) {
    console.log('using cached data.');
    var text = fs.readFileSync(cacheFileName,'utf8');
    cb(null, text);
  }
  else {
    request(requestOptions, function(error, response, body){
      handleError(error);
      if (response.statusCode != 200) {
        console.log('the query failed: ' + response.statusCode);
        process.exit(1);
      }
      if (opt.options.verbose) {
        console.log(body);
      }
      if (!fs.existsSync(defaults.dirs.cache)){
        fs.mkdirSync(defaults.dirs.cache);
      }
      fs.writeFileSync(cacheFileName, body);
      cb(null, body);
    });
  }
}

function insertData(dataTable, apiname, date, volume){
  if ( ! dataTable[apiname]) {
    dataTable[apiname] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  var month = parseInt(dateFormat(date,'m'));
  dataTable[apiname][month - 1] = volume;
}

function processJsonAnalyticsData(payload) {
  var dataTable = {};
  var r = JSON.parse(payload);
  if (r.environments[0].dimensions) {
    r.environments[0].dimensions.forEach(function(dimension){
      // dimension.name => api name
      var messageCount = dimension.metrics[0];
      messageCount.values.forEach(function(record){
        var date = addOneDay(new Date(record.timestamp));
        var volume = parseFloat(record.value);
        if (opt.options.verbose) {
          console.log(sprintf('%-28s %26s %f', dimension.name, dateFormat(date, "isoDateTime"), volume ));
        }
        insertData(dataTable, dimension.name, date, volume);
      });
    });
  }
  return dataTable;
}

function getDataForOneEnvironment(options){
  return function(environment, callback) {
    options.environment = environment;
    retrieveData(options, function(e, results){
      handleError(e);
      callback(null, { environment: environment, data : processJsonAnalyticsData(results) });
    });
  };
}


function getNewGsuiteToken(oAuth2Client, tokenStashPath, callback) {
  console.log('You must authorize this application...');
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  // Authorize this app by visiting the url
  opn(authUrl, {wait: false});
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('Enter the one-time-code: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return callback(err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(tokenStashPath, JSON.stringify(token, null, 2) + '\n', (err) => {
        if (err) console.error(err);
        //console.log('Token stashed in %s', config.tokenStashPath);
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function oauth2Authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const tokenStashPath = path.join(defaults.dirs.cache, ".gsheets_token_stash.json");

  // Check if we have previously stored a token.
  fs.readFile(tokenStashPath, (e, token) => {
    if (e) return getNewGsuiteToken(oAuth2Client, tokenStashPath, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

function createSheet(label, lines) {
  return function(auth) {
    const sheets = google.sheets({version: 'v4', auth});
    const today = dateFormat(new Date(), 'yyyy-mmm-dd');

    var request = {
          resource: {
            properties : {
              title: "API Traffic Summary: " + opt.options.org + ' as of ' + today
            }
          }
        };

    sheets.spreadsheets.create(request, function(e, createResponse) {
      handleError(e);
      // import data
      var options = {
            spreadsheetId: createResponse.data.spreadsheetId,
            range: sprintf("A1:P%d", lines.length +1),
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: lines
            }
          };

      sheets.spreadsheets.values.update(options, (e, updateResponse) => {
        handleError(e);
        // make some changes
        var request = {
              spreadsheetId: createResponse.data.spreadsheetId,
              resource: {
                "requests": [
                  // specify sheet name
                  {
                    update_sheet_properties: {
                      properties: {sheet_id: 0, title: label},
                      fields: 'title'
                    }
                  },
                  // format all the numbers
                  {
                    "repeatCell": {
                      "range": {
                        "sheetId": 0,
                        "startRowIndex": 1,
                        "endRowIndex": lines.length + 2,
                        "startColumnIndex": 3,
                        "endColumnIndex": 16
                      },
                      "cell": {
                        "userEnteredFormat": {
                          "numberFormat": {
                            "type": "NUMBER",
                            "pattern": "#,##0"
                          }
                        }
                      },
                      "fields": "userEnteredFormat.numberFormat"
                    }
                  },
                  // this attempt to insert sum formulas,
                  // did not work. Dearth of examples !
                  // {
                  //   "repeatCell": {
                  //     "range": {
                  //       "sheetId": 0,
                  //       "startRowIndex": lines.length + 2,
                  //       "endRowIndex": lines.length + 2,
                  //       "startColumnIndex": 3,
                  //       "endColumnIndex": 15
                  //     },
                  //     "cell": {
                  //       "userEnteredValue": {
                  //         "formulaValue": formula
                  //       }
                  //     },
                  //     "fields": "userEnteredValue.formulaValue"
                  //   }
                  // }

                ]
              }
            };

        sheets.spreadsheets.batchUpdate(request, function(e, sheetUpdateResponse) {
          handleError(e);
          // generate sum formulas
          var formuli = 
            Array(13).fill(0).map( (x, i) => String.fromCharCode(65 + 3 + i))
            .map(c => sprintf("=SUM(%s2:%s%d)", c, c, lines.length));
          // insert the formulas
          var options = {
                spreadsheetId: createResponse.data.spreadsheetId,
                range: sprintf("D%d:P%d", lines.length +1, lines.length +1),
                valueInputOption: 'USER_ENTERED',
                resource: {
                  values: [formuli]
                }
              };
          sheets.spreadsheets.values.update(options, (e, updateResponse) => {
            handleError(e);
            var sheetUrl = sprintf('https://docs.google.com/spreadsheets/d/%s/edit', createResponse.data.spreadsheetId);
            console.log('sheet url: %s', sheetUrl);
            opn(sheetUrl, {wait: false});
          });
        });
      });
    });
  };
}

function emitCsvFile(label, lines) {
  if (!fs.existsSync(defaults.dirs.output)){
    fs.mkdirSync(defaults.dirs.output);
  }
  const thisMinute = dateFormat(new Date(), 'yyyymmddHHMM');
  const outputFile = path.join(defaults.dirs.output, label + '--' + thisMinute + ".csv");
  console.log('writing CSV output to   %s', outputFile);
  const stream = fs.createWriteStream(outputFile, {flags:'w'});
  lines.forEach(function(line){
    stream.write(line.join(', ') + '\n');
  });
  stream.end();
}


function doneAllEnvironments(e, results) {
  handleError(e);

  if (opt.options.verbose){
    console.log('all done');
    console.log(JSON.stringify(results));
  }

  var lines = [];
  var line = ["apiname", "org", "env"]
    .concat("Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(',').map( m => m + '-2018'))
    .concat(["Total"]);
  lines.push(line);

  const add = (a, b) => a + b;
  results.forEach(function(dataTable) {
   Object.keys(dataTable.data).sort().forEach(function(key) {
     const row = dataTable.data[key];
     const sum = row.reduce(add) ;
     line = [key, opt.options.org, dataTable.environment]
       .concat(row)
       .concat([sum]);
     lines.push(line);
   });
  });

  const label = sprintf('traffic-by-api--%s-%s', opt.options.org, opt.options.year);

  if (opt.options.sheet) {
    // Load client secrets from a local file.
    //const clientSecretFile = path.join(defaults.cachedatadir, "gsheets_client_secret.json");
    const clientSecretFile = path.join(".", "gsheets_client_secret.json");
    fs.readFile(clientSecretFile, (e, content) => {
      if (e) {
        console.log('Error loading client secret file:', e);
        return;
      }
      oauth2Authorize(JSON.parse(content), createSheet(label, lines));
    });
  }
  else {
    emitCsvFile(label, lines);
  }
}

// ========================================================================================
console.log(
  'Apigee Edge Analytics Summarizer tool, version: ' + version + '\n' +
    'Node.js ' + process.version + '\n');

var opt = getopt.parse(process.argv.slice(2));

if ( ! opt.options.org) {
  console.log('You must specify an organization');
  getopt.showHelp();
  process.exit(1);
}

if ( ! opt.options.year) {
  opt.options.year = new Date().getFullYear();
}

if (opt.options.verbose) {
  console.log('using year: ' + opt.options.year);
}

getEnvironments(function(e, environments){
  handleError(e);
  var firstDayOfYear = new Date(parseInt(opt.options.year), 0, 1);
  var lastDayOfYear = new Date(parseInt(opt.options.year), 11, 31);
  var options = {
        organization : opt.options.org,
        startTime: firstDayOfYear,
        endTime : lastDayOfYear,
        nocache : opt.options.nocache
      };
  async.mapSeries(environments,
                  getDataForOneEnvironment(options),
                  doneAllEnvironments);
});
