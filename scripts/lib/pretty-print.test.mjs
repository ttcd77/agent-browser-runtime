import { describe, it, expect } from "vitest";
import { prettyPrintJavaScript } from "./pretty-print.mjs";

// Characterization tests pinning the behavior of the heuristic JavaScript
// pretty-printer carved out of agent-cdp-server.mjs. The printer is a
// brace/semicolon-driven reformatter (not a parser), so these tests lock its
// exact re-indentation output, its preservation of string literals and
// comments, the byte-count fields it reports, and its honoring of a custom
// indent string. Outputs were captured from the live function before extraction
// so they assert real behavior, not a smoke-load.

describe("prettyPrintJavaScript", () => {
  it("re-indents a function body, opening a block on '{' and breaking on ';' and '}'", () => {
    const r = prettyPrintJavaScript("function f(){var a=1;return a;}");
    expect(r.mode).toBe("heuristic");
    expect(r.prettyText).toBe("function f(){\n  var a=1;\n  return a;\n}");
    expect(r.originalBytes).toBe(31);
    expect(r.prettyBytes).toBe(38);
  });

  it("breaks before 'else' because '}' followed by a non-closer forces a newline", () => {
    const r = prettyPrintJavaScript("if(x){y();}else{z();}");
    expect(r.prettyText).toBe("if(x){\n  y();\n}\nelse{\n  z();\n}");
  });

  it("preserves string-literal contents verbatim, ignoring braces/semicolons inside quotes", () => {
    const r = prettyPrintJavaScript('var s="a;b{c}";var t=1;');
    expect(r.prettyText).toBe('var s="a;b{c}";\nvar t=1;');
  });

  it("preserves a line comment, emitting a leading newline before it", () => {
    const r = prettyPrintJavaScript("// comment\nvar a=1;");
    expect(r.prettyText).toBe("\n// comment\nvar a=1;");
  });

  it("keeps comma-separated call arguments on one line with no space before ')'", () => {
    const r = prettyPrintJavaScript("a(1,2,3);");
    expect(r.prettyText).toBe("a(1,2,3);");
  });

  it("honors a custom indent string", () => {
    const r = prettyPrintJavaScript("function f(){return 1;}", { indent: "\t" });
    expect(r.prettyText).toBe("function f(){\n\treturn 1;\n}");
  });

  it("returns an empty pretty body with zero pretty bytes for empty input", () => {
    const r = prettyPrintJavaScript("");
    expect(r.prettyText).toBe("");
    expect(r.originalBytes).toBe(0);
    expect(r.prettyBytes).toBe(0);
  });
});
