# dx/fields META

- Per-type field renderer registry (FIELD_COMPONENTS map in `index.ts`).
- Each file is one `FieldComponent<T>` implementation.
- `field-values.ts`: shared toFieldValue/buildFieldValue — used by both top-level and nested fields (group/repeater/blocks).
- `types.ts`: FieldComponentProps contract.
- `richtext-schema.ts`: Tiptap doc validator + plain-text extractor.
- `ExtraFieldsPanel.tsx`: the admin's additional fields (`data.extra`, lib/extra-fields.ts)
  drawn with the leaf components above; shared by FormView and custom layouts (blog).
- Adding a new field type:
  1. add `leafFieldSchema` to `manifest.ts` FIELD_TYPES;
  2. add component file here;
  3. register in `index.ts`;
  4. add validation branch in `content-provider.ts validateField`.
- Public-mode allowlist (extra narrow) is enforced in `FormView.publicRenderableFields`, not here.
