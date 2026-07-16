"use client";

import type { ComponentType } from "react";
import { getAdminFormLayout } from "../layout-registry";
import { FormView, type AdminFormViewProps } from "./FormView";
import type { DeclarativeContentType } from "../manifest";

// Client surface that decides between a fixed-entry layout.tsx (registered
// at module load) and the generic FormView baseline.
//
// The layout registry is populated synchronously at module-load time (each
// extension's layout.tsx calls registerAdminFormLayout when its module is
// evaluated). By the time this component renders, the registry is already
// populated — so we do a plain synchronous Map lookup, no hooks needed.
//
// Missing layout → generic FormView (auto2col / single / manual via
// contentType.layout).

export interface AdminFormSurfaceProps extends AdminFormViewProps {
  contentType?: DeclarativeContentType;
}

export function AdminFormSurface(props: AdminFormSurfaceProps) {
  const layout = getAdminFormLayout(props.extId);

  if (layout) {
    const Layout = layout as unknown as ComponentType<AdminFormViewProps>;
    return <Layout {...props} />;
  }

  return (
    <FormView
      extId={props.extId}
      typeName={props.typeName}
      fields={props.fields}
      slugField={props.slugField}
      mode={props.mode}
      backHref={props.backHref}
      initialId={props.initialId}
      initialData={props.initialData}
      initialStatus={props.initialStatus}
      initialPublishAt={props.initialPublishAt}
      layout={props.contentType?.layout}
      locale={props.locale}
    />
  );
}
