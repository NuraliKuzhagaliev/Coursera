import test from "node:test";
import assert from "node:assert/strict";
import { confirmedResult, makePrompt, parseAnswer, resultForCourse, Manual } from "../src/core.js";

const assessment = { title: "Quiz", peer: false, instructions: "Rubric", questions: [
  { id: "q1", type: "multiple", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] },
  { id: "q2", type: "number" },
  { id: "q3", type: "text" }
] };
const sample = { requestId: "r", manual: "", answers: [
  { id: "q2", value: "1.4e-2" }, { id: "q1", choices: ["o2", "o1"] }, { id: "q3", value: "answer" }
] };

test("matches request, option IDs and numeric format, restores original order", () => {
  assert.match(makePrompt(assessment, "r"), /"instructions":"Rubric"/);
  assert.deepEqual(parseAnswer(JSON.stringify(sample), "r", assessment).map(answer => answer.id), ["q1", "q2", "q3"]);
  assert.throws(() => parseAnswer(JSON.stringify(sample), "stale", assessment), /requestId/);
  const invalid = structuredClone(sample);
  invalid.answers[1].choices = ["o9"];
  assert.throws(() => parseAnswer(JSON.stringify(invalid), "r", assessment), /варианты/);
  invalid.answers[1].choices = ["o1"];
  invalid.answers[0].value = "Infinity";
  assert.throws(() => parseAnswer(JSON.stringify(invalid), "r", assessment), /значение/);
  assert.throws(() => parseAnswer('{"requestId":"r","manual":"Нужны измерения","answers":[]}', "r", assessment), Manual);
});

test("an old failure cannot confirm a new submission", () => {
  const pending = { baseline: { status: "failed", hadFailure: true, count: 1, attempt: "one" } };
  assert.equal(confirmedResult({ status: "failed", count: 1, attempt: "one" }, pending), null);
  assert.equal(confirmedResult({ status: "failed", count: 2, attempt: "two" }, pending), "failed");
  assert.equal(confirmedResult({ status: "passed" }, pending), "passed");
  assert.equal(confirmedResult({ status: "open" }, pending), null);
});

test("passing tasks do not imply an issued certificate", () => {
  assert.equal(resultForCourse({ tasks: { one: { status: "passed" } } }), "awaitingCertificate");
  assert.equal(resultForCourse({ tasks: { one: { status: "passed" }, two: { status: "skippedVisual" } } }), "manual");
  assert.equal(resultForCourse({ tasks: { one: { status: "passed" } }, reviews: [{}] }), "manual");
  assert.equal(resultForCourse({ tasks: { one: { status: "peer" } } }), "peer");
  assert.equal(resultForCourse({ tasks: { one: { status: "uncertain" } } }), "manual");
  assert.equal(resultForCourse({ status: "certificate", tasks: {} }), "certificate");
});

test("extracts source verbatim or identifies a scoped attachment for the exact filename", () => {
  const assignment = { questions: [{ id: "q1", type: "file", fileSpec: {
    exactName: "submission.py", suggestedName: "submission.py", extensions: [".py"]
  } }] };
  const content = "def f():\r\n    return 1\r\n\r\n";
  assert.deepEqual(parseAnswer({ text: "Copy code", code: [content] }, "current", assignment),
    [{ id: "q1", file: { name: "submission.py", content } }]);
  assert.deepEqual(parseAnswer({ text: "submission.py", attachments: [{ name: "submission.py", id: "attachment-1" }] },
    "current", assignment), [{ id: "q1", file: { name: "submission.py", attachment: "attachment-1" } }]);
  assert.throws(() => parseAnswer({ text: "other.py", attachments: [{ name: "other.py", id: "attachment-1" }] },
    "current", assignment), /подходящим именем/);
});
