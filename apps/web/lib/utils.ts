import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Combines multiple class names or class name arrays into a single string,
 * resolving Tailwind CSS class conflicts.
 *
 * @param {...ClassValue[]} inputs - An array of class names or conditional class objects.
 * @returns {string} The merged and optimized class name string.
 */
export function cn(...inputs: ClassValue[]): string {
  // Uses clsx to handle conditional classes and arrays,
  // then uses twMerge to intelligently merge Tailwind classes, resolving conflicts.
  return twMerge(clsx(inputs))
}

// Add other utility functions here as needed throughout the project.
// For example: date formatting, API helpers, etc.

