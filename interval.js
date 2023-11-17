// Copyright 2018 - 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
//
// You may obtain a copy of the License at
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// last saved: <2023-November-17 13:46:07>
//
/* jshint esversion: 9, node: true, strict: implied */
/* global process, console, Buffer, require*/

const moment = require("moment");
const _loop = Symbol("loop");

class Interval {
  constructor(start, end, daily) {
    this.daily = daily;
    this.timeUnit = daily ? "day" : "month";
    this.dateFormat = daily ? "YYYYMMDD" : "YYYYMM";
    this.dateFormat2 = daily ? "YYYYMMDD" : "YYYYMMM";
    if (typeof start === "string") {
      const startMoment = moment(start, this.dateFormat).startOf("month");
      const endMoment = end
        ? moment(end, this.dateFormat)
        : moment(startMoment).endOf("month");
      this.start = startMoment.toDate();
      this.end = endMoment.toDate();
    } else {
      this.start = start;
      this.end = end;
    }
    this.incrementDate = (t) => t.add(1, this.daily ? "days" : "months");
  }

  [_loop](fn) {
    //console.log(`LOOP start: ` + moment(this.start).toString());
    for (
      let t = moment(this.start), end = moment(this.end), ix = 0;
      t <= end;
      t = this.incrementDate(t), ix++
    ) {
      fn(t, ix);
    }
  }

  getPeriodColumnHeads() {
    // Return an array containing column heads, one for each period (month or day).
    // The number of columns returned depends on the chart time period.

    const format = this.daily ? "MMM DD" : "YYYY-MMM";
    // daily: Each value in the array is a monthname and number: 'Mar 06'.
    // monthly: each value in the array is a month and year, formatted as a string: Jan-2018
    const r = [];
    this[_loop]((t) => r.push(t.format(format)));
    return r;
  }

  getRowOfZeros() {
    const r = [];
    this[_loop](() => r.push(0));
    return r;
  }

  getSegments() {
    const r = [];
    this[_loop]((t, _ix) => {
      const t1 = moment(t).endOf("month");
      r.push([moment(t), t1]);
    });
    return r;
  }

  getPeriod() {
    return `${moment(this.start).format(this.dateFormat2)}-${moment(this.end).format(this.dateFormat2)}`;
  }

  durationInDays() {
    return Math.round(moment.duration(this.end.valueOf() - this.start.valueOf()).as('days'));
  }

  getColumnNumber(thisMoment) {
    // into what column does this moment fit?
    // thisMoment = milliseconds since epoch, eg output of Date.parse()
    let myIndex = 0;
    this[_loop]((t, ix) => {
      if (thisMoment >= t) {
        myIndex = ix;
      }
    });
    return myIndex;
  }
}

module.exports = Interval;
