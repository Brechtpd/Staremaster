import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ResizableColumnsProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initialRatio?: number;
  minLeft?: number;
  minRight?: number;
  storageKey?: string;
}

export const ResizableColumns: React.FC<ResizableColumnsProps> = ({
  left,
  right,
  initialRatio = 0.6,
  minLeft = 320,
  minRight = 320,
  storageKey
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointerActive = useRef(false);
  const [ratio, setRatio] = useState(initialRatio);

  useEffect(() => {
    if (!storageKey) {
      setRatio(initialRatio);
      return;
    }
    let restored = false;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = Number.parseFloat(stored);
        if (!Number.isNaN(parsed) && parsed > 0 && parsed < 1) {
          setRatio(parsed);
          restored = true;
        }
      }
    } catch (error) {
      console.warn('[columns] failed to load ratio', error);
    }
    if (!restored) {
      setRatio(initialRatio);
    }
  }, [storageKey, initialRatio]);

  useEffect(() => {
    if (!storageKey) {
      return;
    }
    try {
      window.localStorage.setItem(storageKey, ratio.toString());
    } catch (error) {
      console.warn('[columns] failed to persist ratio', error);
    }
  }, [ratio, storageKey]);

  const clampRatio = useCallback(
    (nextRatio: number) => {
      const container = containerRef.current;
      if (!container) {
        return nextRatio;
      }
      const width = container.getBoundingClientRect().width;
      const minLeftRatio = minLeft / width;
      const minRightRatio = minRight / width;
      return Math.min(1 - minRightRatio, Math.max(minLeftRatio, nextRatio));
    },
    [minLeft, minRight]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!pointerActive.current) {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const nextRatio = clampRatio((event.clientX - rect.left) / rect.width);
      setRatio(nextRatio);
      event.preventDefault();
    },
    [clampRatio]
  );

  const stopResizing = useCallback(() => {
    if (!pointerActive.current) {
      return;
    }
    pointerActive.current = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopResizing);
  }, [handlePointerMove]);

  useEffect(() => {
    return () => {
      stopResizing();
    };
  }, [stopResizing]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerActive.current = true;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  return (
    <div className="resizable-columns" ref={containerRef}>
      <div className="resizable-columns__pane" style={{ flexBasis: `${ratio * 100}%` }}>
        {left}
      </div>
      <div
        className="resizable-columns__divider"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
      />
      <div className="resizable-columns__pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {right}
      </div>
    </div>
  );
};
