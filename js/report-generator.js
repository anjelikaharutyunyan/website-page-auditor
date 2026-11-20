// Finalizes scan reports. Pure functions (no DOM, no chrome.*) so they can be unit-tested in Node.
(function (root, factory) {
  const utils = typeof module === "object" && module.exports ? require("./qa/qa-utils.js") : root.__webQAUtils;
  const api = factory(utils);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__webQAReport = api;
})(typeof self !== "undefined" ? self : this, function (U) {
  "use strict";

  const SCHEMA = "web-qa-report/1";

  function finalizeReport(report) {
    const results = U.sortResults(U.dedupeResults(U.withoutInfo(report.results || [])));
    return { ...report, schema: SCHEMA, results, summary: U.summarize(results) };
  }

  return { SCHEMA, finalizeReport };
});
