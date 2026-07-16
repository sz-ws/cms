import { describe, it, expect } from "vitest";
import {
  sameFieldValues,
  normalizeValue,
} from "../src/ext/dx/views/form-dirty";

// Regression cover for the "Unsaved changes 幽靈" bug: the generic FormView lit
// the unsaved-changes bar on entry for content types with object/array-valued
// fields (richtext / group / repeater / blocks / relations). Root cause was a
// per-key reference `!==` — a mount-time no-op re-emit (e.g. Tiptap onUpdate)
// produced a deeply-equal-but-fresh object and read as dirty. sameFieldValues
// compares by value after symmetric normalisation, so it must not.

describe("sameFieldValues — the dirty guard", () => {
  it("treats a deeply-equal-but-fresh richtext doc as NOT dirty (the bug)", () => {
    const doc = () => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Midnight Diner" }] },
      ],
    });
    // Same content, two distinct object references — what Tiptap re-emits.
    const initial = { title: "Midnight Diner", body: doc() };
    const current = { title: "Midnight Diner", body: doc() };
    expect(initial.body).not.toBe(current.body); // different references
    expect(sameFieldValues(current, initial)).toBe(true); // ...but not dirty
  });

  it("treats a fresh-but-equal group object as NOT dirty", () => {
    const initial = { hero: { heading: "Hi", subheading: "There", image: "" } };
    const current = { hero: { heading: "Hi", subheading: "There", image: "" } };
    expect(sameFieldValues(current, initial)).toBe(true);
  });

  it("treats a fresh-but-equal repeater/blocks array as NOT dirty", () => {
    const rows = () => [
      { question: "Q1", answer: { type: "doc", content: [] } },
      { question: "Q2", answer: { type: "doc", content: [] } },
    ];
    expect(sameFieldValues({ faqs: rows() }, { faqs: rows() })).toBe(true);
  });

  it("treats fresh-but-equal relations arrays as NOT dirty", () => {
    expect(sameFieldValues({ similar: ["a", "b"] }, { similar: ["a", "b"] })).toBe(
      true,
    );
  });

  // Empty ⇄ absent normalisation (空值歸一 / 缺鍵補預設).
  it("treats empty string, undefined and missing key as equal", () => {
    expect(sameFieldValues({ tag: "" }, { tag: undefined })).toBe(true);
    expect(sameFieldValues({ tag: "" }, {})).toBe(true);
    expect(sameFieldValues({ relatedItem: "" }, {})).toBe(true);
  });

  it("treats an empty Tiptap doc as equal to an unset richtext field", () => {
    expect(
      sameFieldValues({ body: { type: "doc", content: [] } }, { body: undefined }),
    ).toBe(true);
  });

  it("treats an empty relations array as equal to an unset field", () => {
    expect(sameFieldValues({ similar: [] }, { similar: undefined })).toBe(true);
    expect(sameFieldValues({ similar: [] }, {})).toBe(true);
  });

  it("treats an empty group as equal to an unset field", () => {
    expect(
      sameFieldValues({ hero: { heading: "", subheading: "" } }, { hero: undefined }),
    ).toBe(true);
  });

  // Genuine edits must still register as dirty (no false negatives).
  it("flags a changed text value as dirty", () => {
    expect(sameFieldValues({ title: "A" }, { title: "B" })).toBe(false);
  });

  it("flags an edited richtext doc as dirty", () => {
    const a = { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] } };
    const b = { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] } };
    expect(sameFieldValues(a, b)).toBe(false);
  });

  it("flags a toggled boolean as dirty (false is a real value, not empty)", () => {
    expect(sameFieldValues({ featured: false }, { featured: true })).toBe(false);
  });

  it("flags number 0 vs unset as dirty (0 is a real value)", () => {
    expect(sameFieldValues({ count: 0 }, { count: undefined })).toBe(false);
  });

  it("flags an added relation as dirty", () => {
    expect(sameFieldValues({ similar: ["a"] }, { similar: [] })).toBe(false);
    expect(sameFieldValues({ similar: ["a", "b"] }, { similar: ["b", "a"] })).toBe(
      false,
    ); // reorder is a real change
  });

  it("flags an added repeater row as dirty", () => {
    expect(
      sameFieldValues({ faqs: [{ question: "Q" }] }, { faqs: [] }),
    ).toBe(false);
  });
});

describe("normalizeValue", () => {
  it("collapses all empties to a single sentinel", () => {
    const empty = normalizeValue(undefined);
    expect(normalizeValue(null)).toBe(empty);
    expect(normalizeValue("")).toBe(empty);
    expect(normalizeValue(NaN)).toBe(empty);
    expect(normalizeValue([])).toBe(empty);
    expect(normalizeValue({})).toBe(empty);
    expect(normalizeValue({ type: "doc", content: [] })).toBe(empty);
  });

  it("keeps real primitives including 0 and false", () => {
    expect(normalizeValue(0)).toBe(0);
    expect(normalizeValue(false)).toBe(false);
    expect(normalizeValue("x")).toBe("x");
  });
});
