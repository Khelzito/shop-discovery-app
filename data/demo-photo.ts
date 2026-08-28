/**
 * Demo imagery for the visual prototype.
 *
 * These are neutral stock photographs used only to evaluate layout. They are
 * placeholders, never merchant-owned content. Candidates showing an
 * identifiable real brand or product are deliberately excluded so a demo
 * visual can never be mistaken for a real catalogue (docs/MASTER_SPEC.md §12).
 *
 * This disappears once real merchant visuals come from Storage.
 */
export function demoPhoto(id: string): string {
  return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=80`;
}
