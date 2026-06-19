"use client";

import Link from "next/link";
import { useState } from "react";

export function Navbar() {
  const [isOpen, setIsOpen] = useState(false);

  const links = [
    { href: "/saas-dashboard", label: "Dashboard" },
    { href: "/positions", label: "Positions" },
    { href: "/style-policies", label: "Policies" },
  ];

  return (
    <nav className="bg-white border-b sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex justify-between items-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Trading SaaS
          </Link>

          {/* Mobile menu button */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="md:hidden p-2"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Desktop menu */}
          <div className="hidden md:flex gap-6">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-gray-700 hover:text-blue-600 font-medium"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Mobile menu */}
        {isOpen && (
          <div className="md:hidden mt-4 space-y-2">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded"
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
