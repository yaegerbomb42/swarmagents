import { redirect } from 'next/navigation';

/** Brand showcase removed — keep assets under /public/brand for icons only. */
export default function BrandIconPage() {
  redirect('/');
}
