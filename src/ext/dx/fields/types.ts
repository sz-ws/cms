import type { DeclarativeField } from "../manifest";

// dx-field-components.md:每個宣告式 field type 對應唯一元件與唯一 stored-value
// 形狀。所有元件實作同一介面 —— FormView 只認得這個介面,不 care 個別型別怎麼畫。
//
// 日期形狀偏離文件之處(已與文件作者同步):此 codebase 的 date 欄位一律以
// epoch 毫秒 number 儲存(見 content-provider.ts 開頭註解、CoreContentProvider.
// toEpoch)。文件原本寫 ISO date string——這裡採 epoch-ms,DateField 的
// value/onChange 皆為 `number | undefined`。

export interface FieldComponentProps<TValue = unknown> {
  value: TValue;
  onChange: (next: TValue) => void;
  field: DeclarativeField;
  error?: string;
  /** true when the form is mid-submit; components may disable interaction. */
  disabled?: boolean;
}

/** Extra prop wired only into SlugField by FormView: source field's live value. */
export interface SlugFieldProps extends FieldComponentProps<string> {
  sourceValue?: string;
}
