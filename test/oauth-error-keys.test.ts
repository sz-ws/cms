import { describe, it, expect } from "vitest";
import { en } from "../src/lib/i18n/en";
import { zhHant } from "../src/lib/i18n/zh-hant";
import { identityErrorKey, oauthErrorKey } from "../src/lib/oauth-error-keys";

// 第三方登入帶回來的錯誤碼 → 畫面上的句子(後台登入頁的 ?error=、帳號頁的 ?error=)。
// 插件自己畫的登入頁有自己的字典,不在這裡。

describe("後台登入頁:錯誤碼 → 字典鍵", () => {
  it("每個錯誤碼有自己的句子;不認得的一律當成「登入失敗」", () => {
    expect(oauthErrorKey("oauth_denied")).toBe("login.error.oauthDenied");
    expect(oauthErrorKey("oauth_state")).toBe("login.error.oauthState");
    expect(oauthErrorKey("oauth_stale")).toBe("login.error.oauthState");
    expect(oauthErrorKey("popup_blocked")).toBe("login.error.popupBlocked");
    expect(oauthErrorKey("not_linked")).toBe("login.error.notLinked");
    expect(oauthErrorKey("email_exists")).toBe("login.error.emailExists");
    expect(oauthErrorKey("oauth_failed")).toBe("login.error.oauthFailed");
    expect(oauthErrorKey("something_else")).toBe("login.error.oauthFailed");
  });

  // 1.76.0:callback 到了別的瀏覽器(手機上很常見:對方的 App 把人送回另一個瀏覽器)。
  // 句子是一個做法,不是指責。
  it("oauth_browser:請他在這個瀏覽器再登入一次", () => {
    expect(oauthErrorKey("oauth_browser")).toBe("login.error.oauthBrowser");
    expect(zhHant["login.error.oauthBrowser"]).toBe("登入要在同一個瀏覽器完成。請在這裡再按一次登入。");
    expect(en["login.error.oauthBrowser"]).toBe(
      "Sign-in needs to finish in the browser where it started. Please sign in again here.",
    );
  });
});

describe("帳號頁(連結其他登入方式):錯誤碼 → 字典鍵", () => {
  it("既有的照舊", () => {
    expect(identityErrorKey("identity_taken")).toBe("account.error.identityTaken");
    expect(identityErrorKey("oauth_failed")).toBe("account.error.identityGeneric");
    expect(identityErrorKey("something_else")).toBe("account.error.identityGeneric");
  });

  it("oauth_browser:請他在這個瀏覽器再按一次連結", () => {
    expect(identityErrorKey("oauth_browser")).toBe("account.error.identityBrowser");
    expect(zhHant["account.error.identityBrowser"]).toBe("連結要在同一個瀏覽器完成。請在這裡再按一次「連結」。");
    expect(en["account.error.identityBrowser"]).toBe(
      "Linking needs to finish in the browser where it started. Press “Link” again here.",
    );
  });
});
