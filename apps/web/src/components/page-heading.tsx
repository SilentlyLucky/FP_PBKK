export function PageHeading({
  title,
  description,
  action,
}: {
  /** Tidak lagi ditampilkan; tetap diterima supaya pemanggil lama tidak rusak. */
  eyebrow?: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
