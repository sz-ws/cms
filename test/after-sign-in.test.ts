import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fill, SlotRegistry, type SlotSource } from "../src/ext/slots";

// 登入之後多走一步(src/ext/after-sign-in.ts 的插槽 AfterSignIn,由 /api/auth/continue 問):
// 插件可以要剛登入的會員先去一個站內的頁面(例如補 Email),原本的目的地放在 ?next= 上帶過去。
// 後台人員不繞路;只收站內路徑;沒人加、加壞了、整個讀不到,登入都照原本的走。

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "guest" | "admin" | "editor" },
  sources: [] as unknown[],
  runtimeBroken: false,
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/sign-in-page", () => ({ publicSignInPage: async () => "/member/sign-in" }));
vi.mock("@/ext/loader", async () => {
  const { SlotRegistry: Registry } = await import("../src/ext/slots");
  return {
    getExtRuntime: async () => {
      if (state.runtimeBroken) throw new Error("runtime unavailable");
      return { slots: new Registry(state.sources as SlotSource[]) };
    },
  };
});

import { AfterSignIn, afterSignInDetour, type AfterSignInStep } from "../src/ext/after-sign-in";
import { GET } from "../src/app/api/auth/continue/route";

const MEMBER = { id: "u1", email: "oauth-line-login-ab12cd34@placeholder.invalid", name: "阿明", role: "guest" as const };
const step = (key: string, path: AfterSignInStep["path"]): AfterSignInStep => ({ key, path });
const plugin = (extId: string, ...steps: unknown[]): SlotSource => ({ extId, fills: [fill(AfterSignIn, (list) => [...list, ...(steps as AfterSignInStep[])])] });
const detour = (sources: SlotSource[], person: { id: string; email: string; role: "guest" | "admin" | "editor" } = MEMBER, destination = "/shop/orders") =>
  afterSignInDetour(new SlotRegistry(sources), person, destination);

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.user = null;
  state.sources = [];
  state.runtimeBroken = false;
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("afterSignInDetour", () => {
  it("沒有人加:不繞路", async () => {
    expect(await detour([])).toBeNull();
  });

  it("有一步要走:去那一步,原本的目的地放在 ?next=", async () => {
    expect(await detour([plugin("members", step("email", () => "/member/email"))])).toBe("/member/email?next=%2Fshop%2Forders");
  });

  it("把剛登入的人交給每一項去問(只有代號與 Email,沒有角色以外的東西)", async () => {
    const path = vi.fn(async () => null);
    await detour([plugin("members", step("email", path))]);
    expect(path).toHaveBeenCalledWith({ id: "u1", email: MEMBER.email });
  });

  it("這個人不用走的那一步(回 null)跳過;照插件填的先後,第一個要走的先去", async () => {
    const sources = [plugin("a", step("terms", async () => null)), plugin("b", step("email", async () => "/member/email"), step("phone", () => "/member/phone"))];
    expect(await detour(sources)).toBe("/member/email?next=%2Fshop%2Forders");
  });

  it("那一步的網址自己有參數:next 加在後面;目的地有參數也原樣帶著", async () => {
    expect(await detour([plugin("a", step("email", () => "/member/email?from=sign-in"))], MEMBER, "/shop/orders?page=2&q=a b")).toBe(
      "/member/email?from=sign-in&next=%2Fshop%2Forders%3Fpage%3D2%26q%3Da+b",
    );
  });

  it("後台人員永遠不繞路,連問都不問", async () => {
    const path = vi.fn(() => "/member/email");
    for (const role of ["admin", "editor"] as const) expect(await detour([plugin("members", step("email", path))], { ...MEMBER, role })).toBeNull();
    expect(path).not.toHaveBeenCalled();
  });

  it.each([
    ["站外網址", "https://evil.test/step"],
    ["// 開頭", "//evil.test/step"],
    ["反斜線(瀏覽器會當成 //)", "/\\evil.test"],
    ["中間有換行", "/mem\nber"],
    ["javascript:", "javascript:alert(1)"],
    ["不是字串", 42],
    ["空字串", ""],
  ])("只收站內路徑(%s):當作沒有這一步,記一筆", async (_name, path) => {
    expect(await detour([plugin("bad", step("email", () => path as string))])).toBeNull();
    expect(String(errors.mock.calls[0][0])).toContain("email");
  });

  it("壞掉的那一項之後,別的還是照常問", async () => {
    const sources = [plugin("bad", step("broken", () => "//evil.test")), plugin("members", step("email", () => "/member/email"))];
    expect(await detour(sources)).toBe("/member/email?next=%2Fshop%2Forders");
  });

  it("問的時候丟例外(同步或非同步):跳過它,記一筆,其他照常", async () => {
    const thrown = step("thrown", () => {
      throw new Error("no such table");
    });
    const rejected = step("rejected", async () => {
      throw new Error("no such table");
    });
    expect(await detour([plugin("a", thrown, rejected)])).toBeNull();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(await detour([plugin("a", thrown, rejected, step("email", () => "/member/email"))])).toBe("/member/email?next=%2Fshop%2Forders");
  });

  it("問了一直沒有回答(卡住):等 2 秒就跳過它,記一筆,其他照常 —— 登入不會被卡住", async () => {
    vi.useFakeTimers();
    try {
      const stuck = step("stuck", () => new Promise<string | null>(() => undefined));
      const alone = detour([plugin("a", stuck)]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await alone).toBeNull();
      expect(String(errors.mock.calls[0][0])).toContain("stuck");

      const withOthers = detour([plugin("a", stuck, step("email", () => "/member/email"))]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await withOthers).toBe("/member/email?next=%2Fshop%2Forders");
    } finally {
      vi.useRealTimers();
    }
  });

  it("寫壞的項目(沒有代號、path 不是函式、不是物件)丟掉", async () => {
    const sources = [plugin("a", null, "email", { key: "Email!", path: () => "/x" }, { key: "email", path: "/member/email" }, step("ok", () => "/member/ok"))];
    expect(await detour(sources)).toBe("/member/ok?next=%2Fshop%2Forders");
  });

  it("整包被換成不是陣列的東西:當作沒有人加", async () => {
    const source: SlotSource = { extId: "bad", fills: [fill(AfterSignIn, () => "nope" as unknown as AfterSignInStep[])] };
    expect(await detour([source])).toBeNull();
  });

  it("同一個代號後填的蓋掉先填的(站台可以換掉插件的那一步)", async () => {
    const site: SlotSource = { extId: "site", layer: "site", fills: [fill(AfterSignIn, (list) => [...list, step("email", () => "/welcome")])] };
    expect(await detour([site, plugin("members", step("email", () => "/member/email"))])).toBe("/welcome?next=%2Fshop%2Forders");
  });

  it("本來就要去那一步的頁面:不再繞一次", async () => {
    const sources = [plugin("members", step("email", () => "/member/email"))];
    expect(await detour(sources, MEMBER, "/member/email")).toBeNull();
    expect(await detour(sources, MEMBER, "/member/email?next=%2Fshop%2Forders")).toBeNull();
  });
});

describe("GET /api/auth/continue", () => {
  const go = async (query = "") => {
    const res = await GET(new Request(`https://shop.test/api/auth/continue${query}`));
    return { status: res.status, location: res.headers.get("location") };
  };
  const emailStep = () => [plugin("members", step("email", (person) => (person.email.endsWith("@placeholder.invalid") ? "/member/email" : null)))];

  it("會員要先走一步:去那一步,帶著原本要去的頁面", async () => {
    state.user = MEMBER;
    state.sources = emailStep();
    expect(await go("?next=%2Fshop%2Forders&stay=%2Fmember%2Fsign-in")).toEqual({ status: 302, location: "https://shop.test/member/email?next=%2Fshop%2Forders" });
  });

  it("沒指定要去哪:帶著登入頁(stay)", async () => {
    state.user = MEMBER;
    state.sources = emailStep();
    expect((await go("?stay=%2Fmember%2Fsign-in")).location).toBe("https://shop.test/member/email?next=%2Fmember%2Fsign-in");
  });

  it("帶去那一步的目的地一樣是驗過的站內路徑:站外的 next 不會被帶過去", async () => {
    state.user = MEMBER;
    state.sources = emailStep();
    expect((await go("?next=%2F%2Fevil.test&stay=https%3A%2F%2Fevil.test")).location).toBe("https://shop.test/member/email?next=%2F");
    expect((await go("?next=%2Fadmin")).location).toBe("https://shop.test/member/email?next=%2F");
  });

  it("不用走那一步的會員(帳號上有 Email):跟以前一樣", async () => {
    state.user = { ...MEMBER, email: "member@shop.test" };
    state.sources = emailStep();
    expect((await go("?next=%2Fshop%2Forders&stay=%2Fmember%2Fsign-in")).location).toBe("https://shop.test/shop/orders");
    expect((await go("?stay=%2Fmember%2Fsign-in")).location).toBe("https://shop.test/member/sign-in");
  });

  it("沒有插件加這一步:跟以前一樣", async () => {
    state.user = MEMBER;
    expect((await go("?next=%2Fshop%2Forders")).location).toBe("https://shop.test/shop/orders");
  });

  it("後台人員不繞路,就算帳號上沒有 Email", async () => {
    state.sources = emailStep();
    for (const role of ["admin", "editor"] as const) {
      state.user = { ...MEMBER, role };
      expect((await go("")).location).toBe("https://shop.test/admin");
      expect((await go("?next=%2Fadmin%2Fext%2Fshop")).location).toBe("https://shop.test/admin/ext/shop");
    }
  });

  it("插件那一層讀不到(runtime 壞了):登入照原本的目的地走", async () => {
    state.user = MEMBER;
    state.sources = emailStep();
    state.runtimeBroken = true;
    expect((await go("?next=%2Fshop%2Forders")).location).toBe("https://shop.test/shop/orders");
    expect(errors).toHaveBeenCalled();
  });

  it("沒登入:回登入頁(不問)", async () => {
    state.sources = emailStep();
    expect((await go("?next=%2Fshop%2Forders")).location).toBe("https://shop.test/member/sign-in");
  });
});
