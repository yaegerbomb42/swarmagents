'use client';

export default function LivePreviewDetail() {
  return (
    <div className="h-full flex flex-col bg-black/20 rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <span className="text-sm">👁</span>
        <span className="text-sm font-medium text-white/80">Live Preview</span>
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="text-3xl opacity-20">👁</div>
          <p className="text-sm text-white/40">Real-time output preview</p>
        </div>
      </div>
    </div>
  );
}
