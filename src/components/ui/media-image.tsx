import { cn } from "@/lib/utils";
import {
  buildSrcSet,
  isTransformableKey,
  snapWidth,
  variantUrl,
} from "@/lib/image-variants";

// CMS 媒體圖的單一出口。admin 與公開站共用(META.md:跨 admin/public 的 primitive
// 放 components/ui/),所以刻意**不加** "use client" —— 它是純呈現、無 hook、無事件,
// server component 與 client component 都直接用得上。
//
// 這裡做三件現成 <img> 沒做的事:
//   1. srcset —— 讓瀏覽器依實際版位與 DPR 挑檔,而不是永遠拉原圖。
//   2. width/height —— 原生尺寸(來自 R2 customMetadata)寫進屬性,配 h-auto
//      讓瀏覽器在圖到之前就把版位留好(CLS)。拿不到尺寸就整組不放,行為退回現況。
//   3. 一致的 loading / decoding 預設。
//
// 用原生 <img> 而非 next/image:媒體來源是任意 storage key,next/image 需要
// 預設網域或自訂 loader,而縮放已經由 /api/files 的變體路徑處理掉了。

export interface MediaImageProps {
  /** storage key。呼叫端必須先過 isMediaKey / isImageKey,這裡不再驗。 */
  mediaKey: string;
  alt: string;
  className?: string;
  /**
   * 這張圖在版型上最大會佔多寬(CSS px)。決定 srcset 的刻度上限與 src 的變體寬度。
   * 縮圖給小值(如 64),hero 給大值 —— 給錯只是抓大或抓小,不會壞。
   */
  maxWidth?: number;
  /** `<img sizes>`。省略時瀏覽器當作 100vw(對滿版圖正確,對縮圖偏保守)。 */
  sizes?: string;
  /** 原生像素尺寸(StoredFile.width / height)。兩個都有才會輸出。 */
  width?: number;
  height?: number;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "low" | "auto";
}

export function MediaImage({
  mediaKey,
  alt,
  className,
  maxWidth,
  sizes,
  width,
  height,
  loading = "lazy",
  fetchPriority,
}: MediaImageProps) {
  const transformable = isTransformableKey(mediaKey);
  const cap = maxWidth === undefined ? undefined : snapWidth(maxWidth);
  const src = transformable
    ? variantUrl(mediaKey, cap === undefined ? {} : { width: cap })
    : variantUrl(mediaKey);
  const srcSet = maxWidth === undefined
    ? buildSrcSet(mediaKey)
    : buildSrcSet(mediaKey, maxWidth);

  // width/height 必須成對:只給一邊瀏覽器算不出比例,反而更容易跳版。
  const hasDims = width !== undefined && height !== undefined;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 任意 storage key 來源;縮放走 /api/files 變體,不需要 next/image 管線。
    <img
      src={src}
      {...(srcSet ? { srcSet } : {})}
      {...(sizes ? { sizes } : {})}
      {...(hasDims ? { width, height } : {})}
      alt={alt}
      loading={loading}
      decoding="async"
      {...(fetchPriority ? { fetchPriority } : {})}
      // h-auto 是配合 width/height 屬性的必要條件:少了它,寬度被 max-w-full
      // 壓縮後高度仍停在屬性值,圖會被拉扁。
      className={cn(hasDims && "h-auto", className)}
    />
  );
}
