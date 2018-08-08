# Apigee Edge Traffic Summarizer

This tool queries the Edge Analytics API to retrieve message_count (traffic volume) statistics for an organization, over a given year.

There are two options for output:

- emit into a .csv file, which can then be imported into a Spreadsheet for further analysis.
- automatically generate a Google Sheet containing the data

## Disclaimer

This example is not an official Google product, nor is it part of an official Google product.

## LICENSE

This material is copyright 2018 Google LLC.
and is licensed under the Apache 2.0 license. See the [LICENSE](LICENSE) file.

## Usage

```
$  node ./trafficByApiSummarizer.js
Apigee Edge Analytics Summarizer tool, version: 20180808-0850
Node.js v10.5.0

You must specify an organization
Usage:
  node trafficByApiSummarizer.js [OPTION]

Options:
  -o, --org=ARG      required. name of the Edge organization
  -u, --username=ARG optional. username for authenticating to Edge
  -n, --netrc        optional. specify in lieu of username to rely on .netrc for credentials.
  -y, --year=ARG     optional. specify a 4-digit year. Default: the current year.
  -v, --verbose      optional. verbose output.
  -S, --sheet        optional. create a Google Sheet with the data. Default: emit .csv file.
  -N, --nocache      optional. do not use cached data; retrieve from stats API
  -h, --help         display this help
```

## Example 1

Generate a google sheet that summarizes the traffic volume data for the current year, for an organization.

```
 node ./trafficByApiSummarizer.js -n -o my-org-name -S
```

The user will be prompted to authenticate to Google, in order to grant
consent to the "API Traffic Summarizer" app to generate a sheet.

While the app requests a scope that allows the tool to create and view sheets, the
tool merely creates a new sheet. It does not read any existing sheets.

When used with the -S option, no .csv file is emitted.


## Example 2

Generate a .csv file that summarizes the traffic volume data for the current year, for an Edge organization.

```
 node ./trafficByApiSummarizer.js -n -o my-org-name
```

When used without the -S option, a .csv file is emitted, and no Google sheet is created.


## Example 3

Generate a .csv file that summarizes the traffic volume data for 2017, for an Edge organization.


```
 node ./trafficByApiSummarizer.js -n -o my-org-name -y 2017
```



## Bugs

* Does not use tokens for authenticating to the Apigee Edge administrative API, won't work in an organization for which single-sign is enabled.

