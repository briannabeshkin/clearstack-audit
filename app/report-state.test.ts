import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { determineReportState } from "./report-state.ts";

// These four cases are exactly the billing-gate behavior requested for
// App Store submission verification: locks when there's no active
// purchase, unlocks when there is, and zero issues shows the free "books
// are clean" state with no paywall regardless of purchase status.

describe("determineReportState", () => {
  test("locks findings when issues exist and there is no active purchase", () => {
    const state = determineReportState({
      dataIncomplete: false,
      issueCount: 3,
      hasActivePayment: false,
    });
    assert.equal(state, "locked");
  });

  test("unlocks findings when issues exist and there is an active purchase", () => {
    const state = determineReportState({
      dataIncomplete: false,
      issueCount: 3,
      hasActivePayment: true,
    });
    assert.equal(state, "unlocked");
  });

  test("shows the free clean state when there are zero issues, even with no purchase", () => {
    const state = determineReportState({
      dataIncomplete: false,
      issueCount: 0,
      hasActivePayment: false,
    });
    assert.equal(state, "clean");
  });

  test("shows the free clean state when there are zero issues, even WITH an active purchase", () => {
    // A shop that purchased previously, then comes back clean on a later
    // visit, should still see "clean" — not "unlocked" — since there's
    // nothing to itemize. Purchase status must not override a zero-issue
    // result.
    const state = determineReportState({
      dataIncomplete: false,
      issueCount: 0,
      hasActivePayment: true,
    });
    assert.equal(state, "clean");
  });

  test("incomplete data takes priority over everything else, including a real issue count", () => {
    const state = determineReportState({
      dataIncomplete: true,
      issueCount: 5,
      hasActivePayment: true,
    });
    assert.equal(state, "incomplete");
  });

  test("incomplete data takes priority even over an otherwise-clean zero-issue result", () => {
    const state = determineReportState({
      dataIncomplete: true,
      issueCount: 0,
      hasActivePayment: false,
    });
    assert.equal(state, "incomplete");
  });

  test("a single issue is enough to require a purchase (boundary: issueCount = 1)", () => {
    const state = determineReportState({
      dataIncomplete: false,
      issueCount: 1,
      hasActivePayment: false,
    });
    assert.equal(state, "locked");
  });
});
