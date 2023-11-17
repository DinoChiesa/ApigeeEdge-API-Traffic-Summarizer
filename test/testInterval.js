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
// ------------------------------------------------------------------
// created: Fri Nov 17 11:34:52 2023
// last saved: <2023-November-17 12:48:18>

/* jshint esversion:9, node:true, strict:implied */
/* global process, console, describe, it, require */

const expect = require("chai").expect;
const moment = require("moment");

const Interval = require("../interval.js");

describe("Interval behavior", function () {
  const interval = new Interval(
    // apply time offset to get "midnight" in Pacific time zone
    new Date(Date.parse("2023-01-01T08:00:00Z")),
    new Date(Date.parse("2023-10-23T08:00:00Z")),
    false
  );

  it("generates the right number of period columns", function () {
    const heads = interval.getPeriodColumnHeads();
    //console.log("heads: ");
    //console.log(JSON.stringify(heads, null, 2));
    expect(heads.length).to.equal(10);
    expect(heads[0]).to.equal("2023-Jan");
  });

  it("computes duration", function () {
    const duration = interval.durationInDays();
    expect(duration).to.equal(295);
  });

  it("finds the right column for a particular date", function () {
    const then = Date.parse("2023-08-14");
    const col = interval.getColumnNumber(then);
    //console.log(`column for ${new Date(then).toISOString()}: ${col}`);
    expect(col).to.equal(7);
  });

  it("produces proper segments", function () {
    const s = interval.getSegments();
    expect(s.length).to.equal(10);
    for (let i = 0; i < s.length; i++) {
      let delta = s[i][1].valueOf() - s[i][0].valueOf();
      //console.log(`delta: ${delta}`);
      let duration = moment.duration(delta);

      expect(Math.round(duration.as("days"))).to.be.oneOf([28, 30, 31]);
    }
  });
});
