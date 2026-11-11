import React from 'react';
export function Select({ children, onValueChange, value }: { children: React.ReactNode; onValueChange?: (v: string) => void; value?: string }) {
  return <>{children}</>;
}
export function SelectTrigger({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <button className={`px-3 py-2 rounded-lg border border-gray-700 bg-gray-800 text-white text-sm ${className}`}>{children}</button>;
}
export function SelectContent({ children }: { children: React.ReactNode }) {
  return <div className="bg-gray-800 border border-gray-700 rounded-lg mt-1">{children}</div>;
}
export function SelectItem({ children, value }: { children: React.ReactNode; value: string }) {
  return <div className="px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">{children}</div>;
}
export function SelectValue({ placeholder }: { placeholder?: string }) {
  return <span className="text-gray-500">{placeholder}</span>;
}
