import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeObjectKey, assertSafeObjectKeySegment } from "../dist/index.js";

test("object keys reject traversal and absolute paths",()=>{
  for(const key of ["../escape","a/../../escape","/absolute","a\\b","a//b"]) {
    assert.throws(()=>assertSafeObjectKey(key));
  }
  assert.equal(assertSafeObjectKey("workspaces/w1/package.json"),"workspaces/w1/package.json");
});

test("release-like key segments are bounded and safe",()=>{
  assert.equal(assertSafeObjectKeySegment("1.2.3"),"1.2.3");
  assert.throws(()=>assertSafeObjectKeySegment("../escape"));
  assert.throws(()=>assertSafeObjectKeySegment("/absolute"));
  assert.throws(()=>assertSafeObjectKeySegment("release%2Fescape"));
});
