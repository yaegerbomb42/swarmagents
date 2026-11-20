import {
  AlignLeft, BarChart3, Code2, Compass, Database, Eye, FlaskConical, Languages, Lock,
  Palette, PenLine, Search, ShieldAlert, Sparkles, Target, Bot, type LucideIcon,
} from 'lucide-react';

const MAP: Record<string, LucideIcon> = {
  AlignLeft, BarChart3, Code2, Compass, Database, Eye, FlaskConical, Languages, Lock,
  Palette, PenLine, Search, ShieldAlert, Sparkles, Target,
};

export function RoleIcon({ name, className }: { name: string; className?: string }) {
  const I = MAP[name] ?? Bot;
  return <I className={className} strokeWidth={1.6} />;
}
