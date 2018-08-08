// trafficByApi.js
// ------------------------------------------------------------------
//
// created: Tue Aug  7 14:42:00 2018
// last saved: <2018-August-07 17:43:54>
//

/* jshint esversion: 6, node: true */
/* global process, console, Buffer */

'use strict';

const request      = require('request'),
      urljoin      = require('url-join'),
      sprintf      = require('sprintf-js').sprintf,
      shajs        = require('sha.js'),
      fs           = require('fs'),
      path         = require('path'),
      Getopt       = require('node-getopt'),
      readlineSync = require('readline-sync'), 
      merge        = require('merge'),
      async        = require('async'),
      netrc        = require('netrc')(),
      dateFormat   = require('dateformat'),
      version      = '20180807-1730',
      mgmtServer   = 'https://api.enterprise.apigee.com',
      defaults     = {
        cachedatadir : 'cache'       
      }, 
    getopt = new Getopt([
      ['o' , 'org=ARG', 'required. name of the Edge organization'],
      ['u' , 'username=ARG', 'optional. username for authenticating to Edge'],
      ['n' , 'netrc', 'optional. specify in lieu of username to rely on .netrc for credentials.'], 
      ['y' , 'year=ARG', 'optional. specify a 4-digit year. Default: the current year.'], 
      ['v' , 'verbose', 'optional. verbose output.'], 
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

  var cacheFileName = path.join(defaults.cachedatadir, sha + '--' + today + '.json');
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
      if (!fs.existsSync(defaults.cachedatadir)){
        fs.mkdirSync(defaults.cachedatadir);
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

function doneAllEnvironments(e, results) {
  handleError(e);

  if (opt.options.verbose){
    console.log('all done');
    console.log(JSON.stringify(results));
  }

  var thisMinute = dateFormat(new Date(), 'yyyymmddHHMM');
  var outputFile = sprintf('traffic-by-api--%s-%s--%s.csv', opt.options.org, opt.options.year, thisMinute);
  console.log('writing output to   %s', outputFile);
  var stream = fs.createWriteStream(outputFile, {flags:'w'});
   
  stream.write("apiname, org, env, ");
  const add = (a, b) => a + b;
  stream.write(("Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(',').map( m => m + '-2018').join(',')) + ',Total\n');

  results.forEach(function(dataTable) {
   Object.keys(dataTable.data).sort().forEach(function(key) {
     const row = dataTable.data[key];
     const sum = row.reduce(add) ;
     stream.write(key + ', ' + opt .options.org + ', ' +
                  dataTable.environment + ', ' + 
                  row.join(', ') + ', ' + sum + '\n');
   });
  });
  stream.end();
}


// ========================================================================================
console.log(
  'Apigee Edge Analytics summarizer tool, version: ' + version + '\n' +
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
