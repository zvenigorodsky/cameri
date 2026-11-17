import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// One of each thing a reporter sends to the server: a pass, a retry chain, a
// skip and an uploaded attachment. Assertions on what arrives live with the
// tests that run this suite.

test("passes", () => {
  expect(1 + 1).toBe(2);
});

test("fails once, then passes on retry", ({}, testInfo) => {
  expect(testInfo.retry).toBeGreaterThan(0);
});

test.skip("is skipped", () => {});

test("attaches a file", async ({}, testInfo) => {
  // By path: the reporter uploads attachments that are files, not inline bodies.
  const path = testInfo.outputPath("note.txt");
  await writeFile(path, "reported by the compatibility suite");
  await testInfo.attach("note", { path, contentType: "text/plain" });
});
