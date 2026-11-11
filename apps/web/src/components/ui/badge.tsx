import React from 'react';
export function Badge({ children, className = '', variant }: { children: React.ReactNode; className?: string; variant?: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-300 ${className}`}>{children}</span>;
}
