# Traffic summarizer

This tool queries the Edge Analytics API to retrieve message_count (traffic volume) statistics for an organization, over a given year.

The output is formatted into a .csv file, which can then be imported into a Spreadsheet for further analysis.

## Usage

```
$ node ./trafficByApi.js
Apigee Edge Analytics summarizer tool, version: 20180807-1730
Node.js v10.5.0

You must specify an organization
Usage:
  node trafficByApi.js [OPTION]

Options:
  -o, --org=ARG      required. name of the Edge organization
  -u, --username=ARG optional. username for authenticating to Edge
  -n, --netrc        optional. specify in lieu of username to rely on .netrc for credentials.
  -y, --year=ARG     optional. specify a 4-digit year. Default: the current year.
  -v, --verbose      optional. verbose output.
  -N, --nocache      optional. do not use cached data; retrieve from stats API
  -h, --help         display this help
```

## Example

```
node ./trafficByApi.js -o sbux-production -n -y 2017
```

## Bugs

* Does not use tokens for authenticating to the Apigee Edge administrative API.
* Does not automatically import the data into a Google Sheet


