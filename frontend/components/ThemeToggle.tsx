'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('los-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('los-theme', 'light');
    }
  };

  return (
    <button
      onClick={toggle}
      className="p-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-all duration-200"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark
        ? <Sun className="w-5 h-5 text-yellow-400" />
        : <Moon className="w-5 h-5 text-gray-600" />
      }
    </button>
  );
}
