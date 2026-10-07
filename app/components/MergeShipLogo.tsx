export function MergeShipLogo({
  size = 40,
  centered = false,
}: {
  size?: number;
  centered?: boolean;
}) {
  return (
    <img
      src="/newlogo.png"
      alt="MergeShip"
      width={size}
      height={size}
      style={{
        display: "block",
        objectFit: "contain",
        marginInline: centered ? "auto" : undefined,
      }}
    />
  );
}
