import { useAppStore } from "../store/appStore";
import { MenuItem, TopMenu } from "./MenuBar";

export function ViewMenu() {
  const lightMode = useAppStore((state) => state.lightMode);
  const setLightMode = useAppStore((state) => state.setLightMode);

  const items: MenuItem[] = [
    { label: lightMode ? "Dark Mode" : "Light Mode", icon: lightMode ? "dark_mode" : "light_mode", enabled: true, onClick: () => setLightMode(!lightMode) },
  ];

  return <TopMenu label="View" items={items} />;
}
