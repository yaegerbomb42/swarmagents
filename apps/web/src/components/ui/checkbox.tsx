import React from 'react';
export function Checkbox({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; id?: string }) {
  return <input type="checkbox" checked={checked} onChange={e => onCheckedChange?.(e.target.checked)} {...props} />;
}
