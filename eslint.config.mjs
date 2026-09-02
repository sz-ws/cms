import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".open-next/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
    // GitNexus 的本機索引(.gitignore 也忽略);它自帶一支 CommonJS runner,
    // 不是這個 repo 的程式碼。
    ".gitnexus/**",
  ]),
  // src/components/og/* 是 OG 圖模板,由 workers-og(satori)在 Worker 裡畫成 PNG,
  // 從來不會進瀏覽器。satori 只認原生 <img>(它自己把 src 抓下來合成進圖),
  // next/image 在那個環境裡根本不存在 —— 這條規則守的 LCP / 頻寬在這裡沒有對象。
  // 所以是關規則,不是逐行 eslint-disable:模板會一直增生,每個都加一行註解等於
  // 把同一句話抄十幾遍,而且新模板漏抄就又回到 warning 堆裡。
  {
    files: ["src/components/og/**/*.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
]);

export default eslintConfig;
