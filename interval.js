// interval.js
// ------------------------------------------------------------------
//
// created: Thu Jan 24 12:08:08 2019
// last saved: <2022-July-26 12:23:28>

/* jshint esversion: 9, node: true */
/* global process, console, Buffer */

'use strict';
const moment  = require('moment'),
      sprintf = require('sprintf-js').sprintf;

const _loop = Symbol('loop');

class Interval {
  constructor(start, end, daily) {
    this.daily = daily;
    this.timeUnit = (daily)?'day':'month';
    this.dateFormat = (daily)?'YYYYMMDD':'YYYYMM';
    if (typeof start === 'string') {
      let startMoment = moment(start,this.dateFormat);
      let endMoment = (!end) ? moment(startMoment).endOf('month') : moment(end,this.dateFormat);
      this.start = startMoment.toDate();
      this.end = endMoment.toDate();
    }
    else {
      this.start = start;
      this.end = end;
    }
    this.incrementDate = (t) => t.add(1, (this.daily)?'days':'months');
  }

  [_loop](fn) {
    for(var t = moment(this.start), end = moment(this.end), ix = 0; t <= end; t = this.incrementDate(t), ix++) {
      fn(t, ix);
    }
  }

  getPeriodColumnHeads() {
    // Return an array containing column heads, one for each period (month or day).
    // The number of columns returned depends on the chart time period.

    let format = (this.daily)?'MMM DD':'YYYY-MMM';
    // daily: Each value in the array is a monthname and number: 'Mar 06'.
    // monthly: each value in the array is a month and year, formatted as a string: Jan-2018
    let r = [];
    this[_loop]((t) => r.push(t.format(format)));
    return r;
  }

  getRowOfZeros() {
    let r = [];
    this[_loop](() => r.push(0));
    return r;
  }

  getPeriod() {
    return sprintf('%s-%s',
                   moment(this.start).format(this.dateFormat),
                   moment(this.end).format(this.dateFormat));
  }

  getColumnNumber(thisMoment) {
    // into what column does this moment fit?
    let myIndex = 0;
    this[_loop]((t, ix) => {
      if (thisMoment >= t) { myIndex = ix; }
    });
    return myIndex;
  }
}

module.exports = Interval;
