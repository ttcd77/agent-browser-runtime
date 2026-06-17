import { describe, it, expect } from "vitest";
import { ManagedPlaywrightDriver } from "./managed-playwright-driver.mjs";

// Unit tests for the shared locator builder's frame-scoping. The engine-collapse
// left a single Playwright engine whose locator() must honor framePath /
// frameIndexes by descending into the target iframe via frameLocator chaining;
// with no frame params it must stay on the page (top-level, shadow-piercing).
// These pin the call chain with a recording stub instead of a real browser.

// Minimal stub that records the Page/FrameLocator method chain the builder walks.
// Both Page and FrameLocator expose frameLocator()/locator()/getByText(); a
// Locator exposes first(). Each call appends to a shared trace array.
function makeStub(trace) {
  const frameLocatorNode = (label) => ({
    frameLocator(selector) {
      trace.push(`frameLocator(${selector})`);
      return frameLocatorNode(`frameLocator(${selector})`);
    },
    nth(index) {
      trace.push(`nth(${index})`);
      return frameLocatorNode(`nth(${index})`);
    },
    locator(selector) {
      trace.push(`locator(${selector})`);
      return { first: () => { trace.push("first()"); return { __label: `${label}.locator(${selector})` }; } };
    },
    getByText(text, options) {
      trace.push(`getByText(${text},exact=${options?.exact})`);
      return { first: () => { trace.push("first()"); return { __label: `${label}.getByText(${text})` }; } };
    },
  });
  return frameLocatorNode("page");
}

function newDriver() {
  return new ManagedPlaywrightDriver({ userDataRoot: "/tmp/abr-test-root" });
}

describe("ManagedPlaywrightDriver.frameScope", () => {
  it("returns the page itself when no frame params are given", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    expect(driver.frameScope(page, {})).toBe(page);
    expect(trace).toEqual([]); // no frame traversal for the top-level case
  });

  it("descends via frameLocator(framePath) for a CSS frame path", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.frameScope(page, { framePath: "#mce_0_ifr" });
    expect(trace).toEqual(["frameLocator(#mce_0_ifr)"]);
  });

  it("descends via frameLocator('iframe').nth(i) per index for frameIndexes", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.frameScope(page, { frameIndexes: [0] });
    expect(trace).toEqual(["frameLocator(iframe)", "nth(0)"]);
  });

  it("chains nested frameIndexes outer->inner", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.frameScope(page, { frameIndexes: [2, 1] });
    expect(trace).toEqual([
      "frameLocator(iframe)", "nth(2)",
      "frameLocator(iframe)", "nth(1)",
    ]);
  });

  it("prefers frameIndexes over framePath when both are present", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.frameScope(page, { frameIndexes: [1], framePath: "#ignored" });
    expect(trace).toEqual(["frameLocator(iframe)", "nth(1)"]);
  });

  it("ignores an empty frameIndexes array (stays top-level)", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    expect(driver.frameScope(page, { frameIndexes: [] })).toBe(page);
    expect(trace).toEqual([]);
  });

  it("rejects non-integer / negative frame indices", () => {
    const driver = newDriver();
    const page = makeStub([]);
    expect(() => driver.frameScope(page, { frameIndexes: [-1] })).toThrow(/non-negative integers/);
    expect(() => driver.frameScope(page, { frameIndexes: [1.5] })).toThrow(/non-negative integers/);
  });
});

describe("ManagedPlaywrightDriver.locator", () => {
  it("resolves selector on the page at top level (unchanged no-frame behavior)", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.locator(page, { selector: "#username" });
    expect(trace).toEqual(["locator(#username)", "first()"]);
  });

  it("resolves text on the page at top level", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.locator(page, { text: "Submit" });
    expect(trace).toEqual(["getByText(Submit,exact=false)", "first()"]);
  });

  it("resolves selector inside the iframe for framePath", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.locator(page, { framePath: "#mce_0_ifr", selector: "#tinymce" });
    expect(trace).toEqual(["frameLocator(#mce_0_ifr)", "locator(#tinymce)", "first()"]);
  });

  it("resolves selector inside the iframe for frameIndexes", () => {
    const driver = newDriver();
    const trace = [];
    const page = makeStub(trace);
    driver.locator(page, { frameIndexes: [0], selector: "body#tinymce" });
    expect(trace).toEqual(["frameLocator(iframe)", "nth(0)", "locator(body#tinymce)", "first()"]);
  });

  it("throws when neither selector nor text is provided", () => {
    const driver = newDriver();
    const page = makeStub([]);
    expect(() => driver.locator(page, {})).toThrow(/selector or text is required/);
  });
});
