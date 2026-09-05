import { X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';

export function Modal({ title, children, onClose, busy = false, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; const previous = document.activeElement as HTMLElement; dialog.showModal(); (dialog.querySelector("input, textarea, select") as HTMLElement | null)?.focus(); document.body.style.overflow = 'hidden'; return () => { dialog.close(); document.body.style.overflow = ''; previous?.focus(); }; }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} aria-labelledby="modal-title">
    <div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="关闭窗口" disabled={busy} onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}

