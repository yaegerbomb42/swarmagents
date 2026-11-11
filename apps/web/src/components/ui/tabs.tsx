import React, { useState, createContext, useContext } from 'react';
const TabCtx = createContext({ active: '', setActive: (v: string) => {} });
export function Tabs({ children, defaultValue = '', className = '' }: { children: React.ReactNode; defaultValue?: string; className?: string }) {
  const [active, setActive] = useState(defaultValue);
  return <TabCtx.Provider value={{ active, setActive }}><div className={className}>{children}</div></TabCtx.Provider>;
}
export function TabsList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex gap-1 ${className}`}>{children}</div>;
}
export function TabsTrigger({ children, value, className = '' }: { children: React.ReactNode; value: string; className?: string }) {
  const { active, setActive } = useContext(TabCtx);
  return <button onClick={() => setActive(value)} className={`px-3 py-1.5 rounded-lg text-sm ${active === value ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'} ${className}`}>{children}</button>;
}
export function TabsContent({ children, value, className = '' }: { children: React.ReactNode; value: string; className?: string }) {
  const { active } = useContext(TabCtx);
  if (active !== value) return null;
  return <div className={className}>{children}</div>;
}
