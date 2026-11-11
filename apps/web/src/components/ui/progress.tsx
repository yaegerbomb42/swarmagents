'use client';

import * as React from 'react';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className = '', value = 0, indicatorClassName = 'bg-cyan-500', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`relative w-full overflow-hidden rounded-full bg-white/10 ${className}`}
        {...props}
      >
        <div
          className={`h-full w-full flex-1 transition-all duration-300 ease-out ${indicatorClassName}`}
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      </div>
    );
  }
);

Progress.displayName = 'Progress';
