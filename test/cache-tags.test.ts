import { describe, it, expect } from "vitest";
import {
  contentTag,
  extTag,
  extIdOfType,
  storageIndexTag,
} from "../src/ext/dx/cache-tags";

// 1.8.0:public content cache 的 tag 命名 helper 是「讀取端 tag」與「mutation 端
// revalidateTag」的唯一真相來源,兩端必須產生一字不差的字串,否則失效會漏掉 —— 故
// 明確鎖住格式。

describe("cache-tags", () => {
  it("contentTag prefixes the full type key with content:", () => {
    expect(contentTag("blog.post")).toBe("content:blog.post");
  });

  it("extTag prefixes the extId with ext:", () => {
    expect(extTag("blog")).toBe("ext:blog");
  });

  it("uses one stable tag for the R2 inventory snapshot", () => {
    expect(storageIndexTag()).toBe("storage:index");
  });

  it("extIdOfType takes the segment before the first dot", () => {
    expect(extIdOfType("blog.post")).toBe("blog");
    // 帶連字號的 extId(ID_RE 允許)仍正確切出
    expect(extIdOfType("my-shop.product")).toBe("my-shop");
  });

  it("extIdOfType returns the whole string when there is no dot", () => {
    expect(extIdOfType("blog")).toBe("blog");
  });

});
