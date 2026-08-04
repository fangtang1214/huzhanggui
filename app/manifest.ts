import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "狐掌柜-直播样品管理系统",
    short_name: "狐掌柜",
    description: "直播样品登记、库存位置、流转与归还全程管理",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f6ef",
    theme_color: "#183e35",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
