import * as React from "react";

import { cn } from "../../lib/shared/utils";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: 通用 Label 基件，由调用方提供 htmlFor 或嵌套控件
  <label ref={ref} className={cn("text-sm font-medium leading-none", className)} {...props} />
));

Label.displayName = "Label";
