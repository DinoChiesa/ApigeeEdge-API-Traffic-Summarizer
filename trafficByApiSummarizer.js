// trafficByApiSummarizer.js
// ------------------------------------------------------------------
//
// created: Tue Aug  7 14:42:00 2018
// last saved: <2018-August-09 10:37:46>
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
      version      = '20180809-1037',
      mgmtServer   = 'https://api.enterprise.apigee.com',
      GOOG_APIS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'],
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

        console.log('\nAuthenticate to %s', mgmtServer);
        var username = opt.options.username;
        if ( !username ) {
          username = readlineSync.question('USER NAME: ');
        }
        // this script never accepts passwords on the command line.
        console.log();
        var password = readlineSync.question('Password for ' + username + ' : ', {hideEchoBack: true});
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


function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function getNewGsuiteToken(oAuth2Client, tokenStashPath, callback) {
  console.log('\nYou must authorize API Traffic Summarizer to create a new sheet.\n');
  console.log('This script will now open a browser tab. After granting consent, you will');
  console.log('receive a one-time code. Return here and paste it in, to continue....\n');

  sleep(4200).then(() => {
    const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: GOOG_APIS_SCOPES
          });
    // Authorize this app by visiting the url
    opn(authUrl, {wait: false});
    const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
    rl.question('Paste the one-time-code: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, (e, token) => {
        if (e) return callback(e);
        oAuth2Client.setCredentials(token);
        // Store the token to disk for later program executions
        fs.writeFile(tokenStashPath, JSON.stringify(token, null, 2) + '\n', (e) => {
          if (e) console.error(e); // this is a non-fatal condition
        });
        callback(oAuth2Client);
      });
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

  // Check if there is a previously stashed token.
  fs.readFile(tokenStashPath, (e, token) => {
    if (e) return getNewGsuiteToken(oAuth2Client, tokenStashPath, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

function summarizeEnvironments(rawlines) {
  var lines = [];
  //rawlines.forEach(x => { console.log(x); });
  rawlines.forEach((x1, i1) => {
    const org = x1[1];
    const env = x1[2];
    var line = lines.find( x => { return (x[0] ==org) && (x[1] == env); });

    if (line) {
      if (i1>0) {
        line.forEach( (val, column) => {
          if (column>1) {
            //console.log('line[%d] := %d + %d', column, line[column], x1[column + 1]);
            line[column] += x1[column + 1];
          }
        });
      }
    }
    else {
      line = [org, env].concat(x1.slice(3));
      //console.log('first sighting (%s): %s', env, JSON.stringify(line));
      lines.push(line);
    }
  });
  //lines.forEach(x => { console.log(x); });
  return lines;
}

function pushOneUpdate(sheets, spreadsheetId) {
  return function(item, cb) {
    // this is the format for .update()
    var options = {
            spreadsheetId: spreadsheetId,
            valueInputOption: 'USER_ENTERED',
            range: item.range,
            resource: {
              values: item.values
            }
        };
    sheets.spreadsheets.values.update(options, (e, updateResponse) => {
      handleError(e);
      cb(null, {});
    });
  };
}

function createSheet(label, lines) {
  return function(auth) {
    console.log('\nCreating a new spreadsheet on Google sheets...');
    const sheets = google.sheets({version: 'v4', auth});
    const today = dateFormat(new Date(), 'yyyy-mmm-dd');
    const sheetTitles = [
            label,
            label.replace('api', 'environment')
          ];
    var request = {
          resource: {
            properties : {
              title: "API Traffic Summary: " + opt.options.org + ' as of ' + today
            },
            sheets : [
              {
                "properties": { sheetId : 0, title: sheetTitles[0] }
              },
              {
                "properties": { sheetId : 1, title: sheetTitles[1] }
              }
            ]
          }
        };

    sheets.spreadsheets.create(request, function(e, createResponse) {
      handleError(e);
      // import data, and add sum formuli
      const lines2 = summarizeEnvironments(lines);
      const columnLetters = Array(16).fill(0).map( (x, i) => String.fromCharCode(65 + i));

      const updateData = [
              {
                range: sprintf("%s!A1:P%d", sheetTitles[0], lines.length+1),
                values: lines
              },
              {
                range: sprintf("%s!D%d:P%d", sheetTitles[0], lines.length +1, lines.length +1),
                values: [columnLetters.slice(3).map(c => sprintf("=SUM(%s2:%s%d)", c, c, lines.length))]
              },
              {
                range: sprintf("%s!A1:O%d", sheetTitles[1], lines2.length +1),
                values: lines2
              },
              {
                range: sprintf("%s!C%d:O%d", sheetTitles[1], lines2.length +1, lines2.length +1),
                values: [columnLetters.slice(2, -1).map(c => sprintf("=SUM(%s2:%s%d)", c, c, lines2.length))]
              },
              {
                range: sprintf("%s!Q2:Q%d", sheetTitles[0], lines.length +1),
                values: Array(lines.length).fill(0).map( (x, i) => [sprintf("=P%d/P$%d", i + 2, lines.length + 1)])
              },
              {
                range: sprintf("%s!P2:P%d", sheetTitles[1], lines2.length +1),
                values: Array(lines2.length).fill(0).map( (x, i) => [sprintf("=O%d/O$%d", i + 2, lines2.length + 1)])
              }
            ];

      // .batchUpdate() failed with a HTTP 413 "Entity Too Large"
      // so this use of async makes N requests in series.
      async.mapSeries(updateData,
                      pushOneUpdate(sheets, createResponse.data.spreadsheetId),
                      function(e, results) {
                        handleError(e);
                        // now, make some format changes
                        var request = {
                              spreadsheetId: createResponse.data.spreadsheetId,
                              resource: {
                                "requests": [
                                  // format the numbers in sheet 0
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
                                  // format the numbers in sheet 0
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 0,
                                        "startRowIndex": 1,
                                        "endRowIndex": lines.length + 2,
                                        "startColumnIndex": 16,
                                        "endColumnIndex": 17
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "numberFormat": {
                                            "type": "NUMBER",
                                            "pattern": "0.00%"
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat.numberFormat"
                                    }
                                  },

                                  // bold the sums in sheet 0
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 0,
                                        "startRowIndex": lines.length,
                                        "endRowIndex": lines.length + 1,
                                        "startColumnIndex": 3,
                                        "endColumnIndex": 16
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "numberFormat": {
                                            "type": "NUMBER",
                                            "pattern": "#,##0"
                                          },
                                          "textFormat": {
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(numberFormat,textFormat)"
                                    }
                                  },
                                  // freeze the header in sheet 0
                                  {
                                    "updateSheetProperties": {
                                      "properties": {
                                        "sheetId": 0,
                                        "gridProperties": {
                                          "frozenRowCount": 1
                                        }
                                      },
                                      "fields": "gridProperties.frozenRowCount"
                                    }
                                  },
                                  // format the header line in sheet 0
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 0,
                                        "startRowIndex": 0,
                                        "endRowIndex": 1,
                                        "startColumnIndex": 3,
                                        "endColumnIndex": 16
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "backgroundColor": {
                                            "red": 0.0,
                                            "green": 0.0,
                                            "blue": 0.0
                                          },
                                          "horizontalAlignment" : "RIGHT",
                                          "textFormat": {
                                            "foregroundColor": {
                                              "red": 1.0,
                                              "green": 1.0,
                                              "blue": 1.0
                                            },
                                            "fontSize": 12,
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  // left justify the first three columns
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 0,
                                        "startRowIndex": 0,
                                        "endRowIndex": 1,
                                        "startColumnIndex": 0,
                                        "endColumnIndex": 3
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "backgroundColor": {
                                            "red": 0.0,
                                            "green": 0.0,
                                            "blue": 0.0
                                          },
                                          "horizontalAlignment" : "LEFT",
                                          "textFormat": {
                                            "foregroundColor": {
                                              "red": 1.0,
                                              "green": 1.0,
                                              "blue": 1.0
                                            },
                                            "fontSize": 12,
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },
                                  // format the numbers in sheet 1
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 1,
                                        "startRowIndex": 1,
                                        "endRowIndex": lines2.length + 2,
                                        "startColumnIndex": 2,
                                        "endColumnIndex": 15
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
                                  // format the percentages in sheet 1
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 1,
                                        "startRowIndex": 1,
                                        "endRowIndex": lines2.length + 2,
                                        "startColumnIndex": 15,
                                        "endColumnIndex": 16
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "numberFormat": {
                                            "type": "NUMBER",
                                            "pattern": "0.00%"
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat.numberFormat"
                                    }
                                  },
                                  // bold the sums in sheet 1
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 1,
                                        "startRowIndex": lines2.length,
                                        "endRowIndex": lines2.length + 1,
                                        "startColumnIndex": 2,
                                        "endColumnIndex": 15
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "numberFormat": {
                                            "type": "NUMBER",
                                            "pattern": "#,##0"
                                          },
                                          "textFormat": {
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(numberFormat,textFormat)"
                                    }
                                  },
                                  // freeze the header in sheet 1
                                  {
                                    "updateSheetProperties": {
                                      "properties": {
                                        "sheetId": 1,
                                        "gridProperties": {
                                          "frozenRowCount": 1
                                        }
                                      },
                                      "fields": "gridProperties.frozenRowCount"
                                    }
                                  },
                                  // format the header in sheet 1
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 1,
                                        "startRowIndex": 0,
                                        "endRowIndex": 1,
                                        "startColumnIndex": 2,
                                        "endColumnIndex": 15
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "backgroundColor": {
                                            "red": 0.0,
                                            "green": 0.0,
                                            "blue": 0.0
                                          },
                                          "horizontalAlignment" : "RIGHT",
                                          "textFormat": {
                                            "foregroundColor": {
                                              "red": 1.0,
                                              "green": 1.0,
                                              "blue": 1.0
                                            },
                                            "fontSize": 12,
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  // left justify the first two columns
                                  {
                                    "repeatCell": {
                                      "range": {
                                        "sheetId": 1,
                                        "startRowIndex": 0,
                                        "endRowIndex": 1,
                                        "startColumnIndex": 0,
                                        "endColumnIndex": 2
                                      },
                                      "cell": {
                                        "userEnteredFormat": {
                                          "backgroundColor": {
                                            "red": 0.0,
                                            "green": 0.0,
                                            "blue": 0.0
                                          },
                                          "horizontalAlignment" : "LEFT",
                                          "textFormat": {
                                            "foregroundColor": {
                                              "red": 1.0,
                                              "green": 1.0,
                                              "blue": 1.0
                                            },
                                            "fontSize": 12,
                                            "bold": true
                                          }
                                        }
                                      },
                                      "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                ]
                              }
                            };

                        sheets.spreadsheets.batchUpdate(request, function(e, sheetUpdateResponse) {
                          handleError(e);
                          var sheetUrl = sprintf('https://docs.google.com/spreadsheets/d/%s/edit', createResponse.data.spreadsheetId);
                          console.log('sheet url: %s', sheetUrl);
                          opn(sheetUrl, {wait: false});
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

  const label = sprintf('by-api--%s-%s', opt.options.org, opt.options.year);
  if (opt.options.sheet) {
    const clientCredentialsFile = path.join(".", "gsheets_client_credentials.json");
    fs.readFile(clientCredentialsFile, (e, content) => {
      if (e) {
        console.log('Error loading client credentials file:', e);
        return;
      }
      oauth2Authorize(JSON.parse(content), createSheet(label, lines));
    });
  }
  else {
    emitCsvFile('traffic-' + label, lines);
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
