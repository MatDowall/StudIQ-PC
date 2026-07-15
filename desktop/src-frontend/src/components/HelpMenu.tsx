import { useState } from "react";
import { AboutDialog } from "./AboutDialog";
import { MenuItem, TopMenu } from "./MenuBar";

export function HelpMenu() {
  const [showAbout, setShowAbout] = useState(false);

  const items: MenuItem[] = [
    { label: "About StudIQ", icon: "info", enabled: true, onClick: () => setShowAbout(true) },
  ];

  return (
    <>
      <TopMenu label="Help" items={items} />
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    </>
  );
}
