import React from 'react';
export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`px-3 py-2 rounded-lg border border-gray-700 bg-gray-800 text-white text-sm ${className}`} {...props} />;
}
