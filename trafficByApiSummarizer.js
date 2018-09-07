// trafficByApiSummarizer.js
// ------------------------------------------------------------------
//
// created: Tue Aug  7 14:42:00 2018
// last saved: <2018-September-07 08:27:44>
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
      version      = '20180907-0823',
      GOOG_APIS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'],
      defaults     = {
        dirs : {
          cache : 'cache',
          output : 'output'
        },
        mgmtServer: 'https://api.enterprise.apigee.com'
      },
    getopt = new Getopt([
      ['o' , 'org=ARG', 'required. name of the Edge organization'],
      ['M' , 'mgmtserver=ARG', 'the Edge mgmt server endpoint. Defaults to ' + defaults.mgmtServer + ' . '],
      ['u' , 'username=ARG', 'optional. username for authenticating to Edge'],
      ['n' , 'netrc', 'optional. specify in lieu of username to rely on .netrc for credentials.'],
      ['P' , 'prior', 'optional. use the prior year or month. Default: the current year/month.'],
      ['m' , 'bymonth', 'optional. collect data for the month. Default: collect data for the year.'],
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
      authorization : getBasicAuthHeader(opt.options.mgmtServer),
      accept : 'application/json'
    }
  };
}

function getEnvironments(cb) {
  var requestOptions = merge(getRequestOptions(), {
        url : urljoin(opt.options.mgmtServer, 'v1/o', opt.options.org)
      });

  console.log('GET "%s"', requestOptions.url);
  request(requestOptions, function(error, response, body){
    handleError(error);
    if (response.statusCode != 200) {
      console.log('the query failed: ' + response.statusCode);
      process.exit(1);
    }
    var result = JSON.parse(body);
    cb(null, result.environments);
  });
}

function retrieveData(options, cb) {
  // time curl -n "$mgmtserver/v1/o/$ORG/e/$ENV/stats/apis?select=sum(message_count)&timeRange=01/01/2018%2000:00~08/01/2018%2000:00&timeUnit=month"
  var query = sprintf('?select=sum(message_count)&timeUnit=%s&timeRange=%s',
                      options.timeUnit,
                      getTimeRange(options.startTime, options.endTime));

  var requestOptions = merge(getRequestOptions(), {
        url : urljoin(opt.options.mgmtServer, 'v1/o', options.organization, 'e', options.environment, 'stats/apis') + query
      });

  console.log('GET "%s"', requestOptions.url);
  var today = dateFormat(new Date(), "yyyymmdd");
  var sha = shajs('sha256')
    .update(JSON.stringify(requestOptions))
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

function insertDataByMonth(dataTable, apiname, date, volume) {
  if ( ! dataTable[apiname]) {
    dataTable[apiname] = Array(12).fill(0);
  }
  var month = parseInt(dateFormat(date,'m'));
  dataTable[apiname][month - 1] = volume;
}

function daysInMonth(date) {
  var lastDayOfMonth = new Date(date.getFullYear(), date.getMonth(), 0);
  var result = lastDayOfMonth.getDate();
  //console.log('days-in-month for %s: %d', dateFormat(date, 'yyyy/mm/dd'), result);
  return result;
}

function insertDataByDay(dataTable, apiname, date, volume) {
  if ( ! dataTable[apiname]) {
    // an array of zeroes, one for each day in the month
    dataTable[apiname] = Array(daysInMonth(endTime)).fill(0);
  }
  var day = parseInt(dateFormat(date,'d'));
  dataTable[apiname][day - 1] = volume;
}

function handleOneMonth(dataTable, dimension) {
  return function(record) {
    var date = addOneDay(new Date(record.timestamp));
    var volume = parseFloat(record.value);
    if (opt.options.verbose) {
      console.log(sprintf('%-28s %26s %f', dimension.name, dateFormat(date, "isoDateTime"), volume ));
    }
    insertDataByMonth(dataTable, dimension.name, date, volume);
  };
}

function handleOneHour(dataTable, dimension) {
  return function(record) {
    var moment = addOneDay(new Date(record.timestamp));
    var volume = parseFloat(record.value);
    if (opt.options.verbose) {
      console.log(sprintf('%-28s %26s %f', dimension.name, dateFormat(moment, "isoDateTime"), volume ));
    }
    insertDataByDay(dataTable, dimension.name, moment, volume);
  };
}

function processJsonAnalyticsData(payload) {
  var dataTable = {};
  var r = JSON.parse(payload);
  if (r.environments[0].dimensions) {
    r.environments[0].dimensions.forEach(function(dimension){
      // dimension.name => api name
      var messageCounts = dimension.metrics[0];
      //console.log('found %d values', messageCounts.values.length);
      var fn = (chartPeriod.length == 4) ? handleOneMonth(dataTable, dimension) :
        handleOneHour(dataTable, dimension);
      messageCounts.values.forEach(fn);
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
    const org = x1[0];
    const env = x1[1];
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
                properties: { sheetId : 0, title: sheetTitles[0] }
              },
              {
                properties: { sheetId : 1, title: sheetTitles[1] }
              }
            ]
          }
        };

    sheets.spreadsheets.create(request, function(e, createResponse) {
      handleError(e);
      // import data, and add sum formuli, produce chart
      const lines2 = summarizeEnvironments(lines);

      // A single .batchUpdate() call failed with a HTTP 413 "Entity Too Large",
      // because the data is too large. To avoid that, this system makes N
      // requests in series.
      const updateData = [
              {
                // raw data
                range: sprintf("%s!R[0]C[0]:R[%d]C[%d]", sheetTitles[0], lines.length, lines[0].length + 1),
                values: lines.map(x => x.concat(['']) )
              },
              {
                // formulas that perform sums of that
                range: sprintf("%s!R[%d]C[%d]:R[%d]C[%d]", sheetTitles[0], lines.length, 3, lines.length, lines[0].length),
                values: [lines[0].slice(3).map((v, i) => sprintf('=SUM(indirect("R2C%d:R%dC%d",false))', i + 4, lines.length, i + 4 ) )]
              },
              {
                // formulas that compute total percentages for sheet0
                range: sprintf("%s!R[%d]C[%d]:R[%d]C[%d]", sheetTitles[0], 1, lines[0].length , lines.length + 1, lines[0].length ),
                values: lines.map( (x, i) => [ sprintf('=indirect("R%dC%d",false)/indirect("R%dC%d",false)', i + 2, lines[0].length, lines.length + 1, lines[0].length) ] )
              },
              {
                // raw data summarized by environment
                range: sprintf("%s!R[0]C[0]:R[%d]C[%d]", sheetTitles[1], lines2.length, lines2[0].length + 1),
                values: lines2.map(x => x.concat(['']) )
              },
              {
                // formulas that compute sums of that
                range: sprintf("%s!R[%d]C[%d]:R[%d]C[%d]", sheetTitles[1], lines2.length, 2, lines2.length, lines2[0].length),
                values: [lines2[0].slice(2).map((v, i) => sprintf('=SUM(indirect("R2C%d:R%dC%d",false))', i + 3, lines2.length, i + 3 ) )]
              },
              {
                // formulas that compute percentages for sheet1
                range: sprintf("%s!R[%d]C[%d]:R[%d]C[%d]", sheetTitles[1], 1, lines2[0].length , lines2.length + 1, lines2[0].length ),
                values: lines2.map( (x, i) => [ sprintf('=indirect("R%dC%d",false)/indirect("R%dC%d",false)', i + 2, lines2[0].length, lines2.length + 1, lines2[0].length) ] )
              }
            ];

      async.mapSeries(updateData,
                      pushOneUpdate(sheets, createResponse.data.spreadsheetId),
                      function(e, results) {
                        handleError(e);
                        // now, make a series of format changes, and add charts

                        var batchRequest = {
                              spreadsheetId: createResponse.data.spreadsheetId,
                              resource: {
                                requests: [

                                  {
                                    // format the numbers in sheet 0
                                    repeatCell: {
                                      range: {
                                        sheetId: 0,
                                        startRowIndex: 1,
                                        endRowIndex: lines.length + 1,
                                        startColumnIndex: 3,
                                        endColumnIndex: lines[0].length + 1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "#,##0"
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat.numberFormat"
                                    }
                                  },

                                  {
                                    // format the percentages in sheet 0
                                    repeatCell: {
                                      range: {
                                        sheetId: 0,
                                        startRowIndex: 1,
                                        endRowIndex: lines.length + 1,
                                        startColumnIndex: lines[0].length ,
                                        endColumnIndex: lines[0].length + 1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "0.00%"
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat.numberFormat"
                                    }
                                  },

                                  {
                                    // bold the sums in sheet 0
                                    repeatCell: {
                                      range: {
                                        sheetId: 0,
                                        startRowIndex: lines.length,
                                        endRowIndex: lines.length + 1,
                                        startColumnIndex: 3,
                                        endColumnIndex: lines[0].length
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "#,##0"
                                          },
                                          textFormat: {
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(numberFormat,textFormat)"
                                    }
                                  },

                                  {
                                    // freeze the header in sheet 0
                                    updateSheetProperties: {
                                      properties: {
                                        sheetId: 0,
                                        gridProperties: {
                                          frozenRowCount: 1
                                        }
                                      },
                                      fields: "gridProperties.frozenRowCount"
                                    }
                                  },

                                  {
                                    // format the header line in sheet 0
                                    repeatCell: {
                                      range: {
                                        sheetId: 0,
                                        startRowIndex: 0,
                                        endRowIndex: 1,
                                        startColumnIndex: 3,
                                        endColumnIndex: lines[0].length + 1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          backgroundColor: {
                                            red: 0.0,
                                            green: 0.0,
                                            blue: 0.0
                                          },
                                          horizontalAlignment : "RIGHT",
                                          textFormat: {
                                            foregroundColor: {
                                              red: 1.0,
                                              green: 1.0,
                                              blue: 1.0
                                            },
                                            fontSize: 12,
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  {
                                    // left justify the first three columns
                                    repeatCell: {
                                      range: {
                                        sheetId: 0,
                                        startRowIndex: 0,
                                        endRowIndex: 1,
                                        startColumnIndex: 0,
                                        endColumnIndex: 3
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          backgroundColor: {
                                            red: 0.0,
                                            green: 0.0,
                                            blue: 0.0
                                          },
                                          horizontalAlignment : "LEFT",
                                          textFormat: {
                                            foregroundColor: {
                                              red: 1.0,
                                              green: 1.0,
                                              blue: 1.0
                                            },
                                            fontSize: 12,
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  {
                                    // resize all the columns
                                    autoResizeDimensions: {
                                      dimensions: {
                                        sheetId: 0,
                                        dimension: "COLUMNS",
                                        startIndex: 0,
                                        endIndex: lines[0].length + 1
                                      }
                                    }
                                  },

                                  {
                                    // format the numbers in sheet 1
                                    repeatCell: {
                                      range: {
                                        sheetId: 1,
                                        startRowIndex: 1,
                                        endRowIndex: lines2.length + 2,
                                        startColumnIndex: 2,
                                        endColumnIndex: lines2[0].length+1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "#,##0"
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat.numberFormat"
                                    }
                                  },

                                  {
                                    // format the percentages in sheet 1
                                    repeatCell: {
                                      range: {
                                        sheetId: 1,
                                        startRowIndex: 1,
                                        endRowIndex: lines2.length + 1,
                                        startColumnIndex: lines2[0].length ,
                                        endColumnIndex: lines2[0].length + 1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "0.00%"
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat.numberFormat"
                                    }
                                  },

                                  {
                                    // bold the sums in sheet 1
                                    repeatCell: {
                                      range: {
                                        sheetId: 1,
                                        startRowIndex: lines2.length,
                                        endRowIndex: lines2.length + 1,
                                        startColumnIndex: 2,
                                        endColumnIndex: lines2[0].length
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          numberFormat: {
                                            type: "NUMBER",
                                            pattern: "#,##0"
                                          },
                                          textFormat: {
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(numberFormat,textFormat)"
                                    }
                                  },

                                  {
                                    // freeze the header in sheet 1
                                    updateSheetProperties: {
                                      properties: {
                                        sheetId: 1,
                                        gridProperties: {
                                          frozenRowCount: 1
                                        }
                                      },
                                      fields: "gridProperties.frozenRowCount"
                                    }
                                  },

                                  {
                                    // format the header in sheet 1
                                    repeatCell: {
                                      range: {
                                        sheetId: 1,
                                        startRowIndex: 0,
                                        endRowIndex: 1,
                                        startColumnIndex: 2,
                                        endColumnIndex: lines2[0].length + 1
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          backgroundColor: {
                                            red: 0.0,
                                            green: 0.0,
                                            blue: 0.0
                                          },
                                          horizontalAlignment : "RIGHT",
                                          textFormat: {
                                            foregroundColor: {
                                              red: 1.0,
                                              green: 1.0,
                                              blue: 1.0
                                            },
                                            fontSize: 12,
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  {
                                    // left justify the first two columns
                                    repeatCell: {
                                      range: {
                                        sheetId: 1,
                                        startRowIndex: 0,
                                        endRowIndex: 1,
                                        startColumnIndex: 0,
                                        endColumnIndex: 2
                                      },
                                      cell: {
                                        userEnteredFormat: {
                                          backgroundColor: {
                                            red: 0.0,
                                            green: 0.0,
                                            blue: 0.0
                                          },
                                          horizontalAlignment : "LEFT",
                                          textFormat: {
                                            foregroundColor: {
                                              red: 1.0,
                                              green: 1.0,
                                              blue: 1.0
                                            },
                                            fontSize: 12,
                                            bold: true
                                          }
                                        }
                                      },
                                      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
                                    }
                                  },

                                  {
                                    // resize all the columns
                                    autoResizeDimensions: {
                                      dimensions: {
                                        sheetId: 1,
                                        dimension: "COLUMNS",
                                        startIndex: 0,
                                        endIndex: lines2[0].length + 1
                                      }
                                    }
                                  },

                                  {
                                    // add a chart.
                                    addChart: {
                                      chart: {
                                        spec: {
                                          title: "Requests",
                                          basicChart: {
                                            chartType: "LINE",
                                            legendPosition: "BOTTOM_LEGEND",
                                            axis: [
                                              {
                                                position: "LEFT_AXIS",
                                                title: "Requests"
                                              }
                                            ],
                                            // domains: [
                                            //   {
                                            //     domain: {
                                            //       sourceRange: {
                                            //         sources: [
                                            //           {
                                            //             sheetId: 0,
                                            //             startRowIndex: 0,
                                            //             endRowIndex: 1,
                                            //             startColumnIndex: 1,
                                            //             endColumnIndex:  lines[0].length + 1
                                            //           }
                                            //         ]
                                            //       }
                                            //     }
                                            //   }
                                            // ],
                                            series: Array(lines.length - 1).fill(0).map( (x, i) => {
                                              return {
                                                series: {
                                                  sourceRange: {
                                                    sources: [
                                                      {
                                                        sheetId: 0,
                                                        startRowIndex: i + 1,
                                                        endRowIndex: i + 2,
                                                        startColumnIndex: 2,
                                                        endColumnIndex: lines[0].length - 1
                                                      }
                                                    ]
                                                  }
                                                },
                                                targetAxis: 'LEFT_AXIS'
                                              };
                                            }),
                                            headerCount: 0
                                          }
                                        },
                                        position: {
                                          newSheet: true
                                        }
                                      }
                                    }
                                  },

                                  // add a second chart.
                                  {
                                    addChart: {
                                      chart: {
                                        spec: {
                                          title: "Requests",
                                          basicChart: {
                                            chartType: "LINE",
                                            legendPosition: "BOTTOM_LEGEND",
                                            axis: [
                                              {
                                                position: "LEFT_AXIS",
                                                title: "Requests"
                                              }
                                            ],
                                            // domains: [
                                            //   {
                                            //     domain: {
                                            //       sourceRange: {
                                            //         sources: [
                                            //           {
                                            //             sheetId: 1,
                                            //             startRowIndex: 0,
                                            //             endRowIndex: 1,
                                            //             startColumnIndex: 1,
                                            //             endColumnIndex: lines2[0].length + 1
                                            //           }
                                            //         ]
                                            //       }
                                            //     }
                                            //   }
                                            // ],
                                            series: Array(lines2.length - 1).fill(0).map( (x, i) => {
                                              return {
                                                series: {
                                                  sourceRange: {
                                                    sources: [
                                                      {
                                                        sheetId: 1,
                                                        startRowIndex: i + 1,
                                                        endRowIndex: i + 2,
                                                        startColumnIndex: 1,
                                                        endColumnIndex: lines2[0].length - 1
                                                      }
                                                    ]
                                                  }
                                                },
                                                targetAxis: 'LEFT_AXIS'
                                              };
                                            }),

                                            headerCount: 1
                                          }
                                        },
                                        position: {
                                          newSheet: true
                                        }
                                      }
                                    }
                                  },

                                 ]
                               }
                            };

                        sheets.spreadsheets.batchUpdate(batchRequest, function(e, sheetUpdateResponse) {
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
  var headerLine = ["org", "env", "apiname"];

  if (chartPeriod.length == 4) {
    headerLine = headerLine.concat("Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(',').map( m => m + '-' + chartPeriod ));
  }
  else {
    // dynamic number of columns => number of days in the month
    headerLine = headerLine.concat(Array(daysInMonth(endTime)).fill(0).map( (x, i) => (i + 1)));
  }

  headerLine = headerLine.concat(["Total"]);
  lines.push(headerLine);

  const add = (a, b) => a + b;
  results.forEach(function(dataTable) {
   Object.keys(dataTable.data).sort().forEach(function(key) {
     const row = dataTable.data[key];
     //console.log('row: ' + JSON.stringify(row));
     const sum = row.reduce(add);
     var line = [opt.options.org, dataTable.environment, key]
       .concat(row)
       .concat([sum]);
     lines.push(line);
   });
  });

  const label = sprintf('by-api--%s-%s', opt.options.org, chartPeriod);
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

if (! opt.options.mgmtServer) {
  opt.options.mgmtServer = defaults.mgmtServer;
  if (opt.options.verbose) {
    console.log('using Edge Admin API endpoint: ' + opt.options.mgmtServer);
  }
}

var now = new Date();
var endTime, startTime, timeUnit, chartPeriod;

if (opt.options.prior) {
  if (opt.options.bymonth) {
    timeUnit = 'day';
    startTime = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endTime = new Date(now.getFullYear(), now.getMonth(), 0);
    chartPeriod = dateFormat(endTime, 'yyyymm');
  }
  else {
    timeUnit = 'month';
    startTime = new Date(now.getFullYear() - 1, 0, 1);
    endTime = new Date(now.getFullYear() - 1, 11, 31);
    chartPeriod = dateFormat(endTime, 'yyyy');
  }
}
else {
  if (opt.options.bymonth) {
    timeUnit = 'day';
    startTime = new Date(now.getFullYear(), now.getMonth(), 1);
    endTime = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    chartPeriod = dateFormat(endTime, 'yyyymm');
  }
  else {
    timeUnit = 'month';
    startTime = new Date(now.getFullYear(), 0, 1);
    endTime = new Date(now.getFullYear(), 11, 31);
    chartPeriod = dateFormat(endTime, 'yyyy');
  }
}

if (opt.options.verbose) {
  console.log('using period ending: ' + dateFormat(startTime, 'mm/dd/yyyy'));
}

var options = {
      organization : opt.options.org,
      nocache : opt.options.nocache,
      startTime: startTime,
      endTime : endTime,
      timeUnit : timeUnit
    };

getEnvironments(function(e, environments){
  handleError(e);
  async.mapSeries(environments,
                  getDataForOneEnvironment(options),
                  doneAllEnvironments);
});
