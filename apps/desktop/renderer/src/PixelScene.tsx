import React from "react";

export const rooms: Record<
  string,
  { code: string; title: string; icon: string; color: string }
> = {
  模型: {
    code: "01 / THE SALOON",
    title: "为你的搭档，接通能量。",
    icon: "chip",
    color: "#e9b56f",
  },
  飞书: {
    code: "02 / POST OFFICE",
    title: "消息抵达，任务出发。",
    icon: "mail",
    color: "#e9aa80",
  },
  Monitor: {
    code: "03 / WATCH TOWER",
    title: "管理监听来源与目标会话。",
    icon: "radar",
    color: "#e3bd83",
  },
  资源: {
    code: "04 / TOOL SHOP",
    title: "装备就位，拓展能力。",
    icon: "box",
    color: "#e9ca87",
  },
  记忆与实验: {
    code: "05 / FIELD LAB",
    title: "保留好想法，试一点新东西。",
    icon: "flask",
    color: "#d6ba9f",
  },
  通用: {
    code: "06 / BASE CAMP",
    title: "把工作站调成你的样子。",
    icon: "gear",
    color: "#d4c78d",
  },
};

export function PixelIcon({ kind = "chip" }: { kind?: string }) {
  const shapes: Record<string, string> = {
    cactus: "M9 0h6v12h3V6h6v12h-9v6H9v-6H0V9h6v3h3z",
    chip: "M6 3h12v3h3v12h-3v3H6v-3H3V6h3zm3 6v6h6V9zM0 8h3v3H0zm0 6h3v3H0zm21-6h3v3h-3zm0 6h3v3h-3zM8 0h3v3H8zm6 0h3v3h-3zM8 21h3v3H8zm6 0h3v3h-3z",
    mail: "M0 3h24v18H0zm3 3v3h3v3h3v3h6v-3h3V9h3V6h-3v3h-3v3H9V9H6V6zm0 9v3h18v-3h-3v3H6v-3z",
    radar:
      "M9 0h6v3H9zM3 3h6v3H3zm12 0h6v3h-6zM0 6h3v12H0zm21 0h3v12h-3zM3 18h6v3H3zm12 0h6v3h-6zM9 21h6v3H9zM9 9h6v6H9zm6-3h3v3h-3zm3-3h3v3h-3z",
    box: "M3 3h18v3h3v15H0V6h3zm0 6v9h18V9h-6v6H9V9zm6-3h6v3H9z",
    flask:
      "M6 0h12v3h-3v6h3v3h3v6h3v6H0v-6h3v-6h3V9h3V3H6zm6 3v9H9v3H6v6h12v-6h-3v-3h-3z",
    gear: "M9 0h6v3h3v3h3v3h3v6h-3v3h-3v3h-3v3H9v-3H6v-3H3v-3H0V9h3V6h3V3h3zm0 9v6h6V9z",
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path d={shapes[kind] || shapes.chip} />
    </svg>
  );
}

/** Pixel-built western scenes, drawn locally and kept sharp at every display scale. */
export function PixelScene({ variant = "home" }: { variant?: string }) {
  const isHome = variant === "home";
  const building =
    variant === "资源" ? "SUPPLIES" : variant === "飞书" ? "POST" : "SALOON";
  return (
    <svg
      className={`pixel-scene ${isHome ? "landscape" : "room-scene"}`}
      viewBox="0 0 320 144"
      preserveAspectRatio={isHome ? "xMidYMid meet" : "xMidYMid slice"}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="-500" width="1320" height="144" fill="#c96946" />
      <rect x="-500" y="34" width="1320" height="32" fill="#df8953" />
      <rect x="-500" y="66" width="1320" height="40" fill="#edaa67" />
      {isHome && (
        <g>
          <path
            d="M-500 87h415V68h29v-9h24v17h39v50h-507zM313 84h38V67h30v9h25V59h33v12h26v16h355v39H313z"
            fill="#b15d43"
          />
          <rect x="-500" y="103" width="1320" height="41" fill="#d78c55" />
          <rect x="-500" y="118" width="1320" height="26" fill="#e9b97b" />
          <rect x="-500" y="136" width="1320" height="8" fill="#d59b61" />
          <path
            d="M-28 133v-20h4v-4h6v24zM345 129V96h5v-5h7v26h6v-13h5v19h-11v6z"
            fill="#596442"
          />
        </g>
      )}
      <path
        d="M174 17h34v5h10v8h5v29h-5v8h-10v5h-34v-5h-10v-8h-5V30h5v-8h10z"
        fill="#ffe0a0"
      />
      <path
        d="M0 85h18V73h16V48h30v9h13v27h19V70h23v-9h27v27h20V79h30V65h18v-9h19v9h12v21h29V75h19v-8h27v59H0z"
        fill="#b15d43"
      />
      <path
        d="M0 93h47v7h39v-6h44v8h52V90h40v8h49v-7h49v53H0z"
        fill="#d78c55"
      />
      <path d="M0 114h40v-5h71v5h87v-7h82v6h40v31H0z" fill="#e9b97b" />
      <path d="M0 133h40v-4h67v5h54v-5h75v5h84v10H0z" fill="#d59b61" />
      <g fill="#eebd81">
        <rect x="9" y="22" width="31" height="3" />
        <rect x="35" y="27" width="23" height="3" />
        <rect x="261" y="37" width="36" height="3" />
      </g>
      <g fill="#bd7950">
        <rect x="35" y="123" width="16" height="2" />
        <rect x="120" y="132" width="12" height="2" />
        <rect x="285" y="125" width="13" height="2" />
        <rect x="78" y="137" width="4" height="2" />
      </g>
      <g fill="#596442">
        <path d="M27 120V71h5v-5h7v5h4v29h8V83h7v23H43v14zM27 97H13V77h7v13h7z" />
        <rect x="31" y="74" width="3" height="41" fill="#81905b" />
      </g>
      <g fill="#465640">
        <path d="M287 122V91h5v-5h6v28h8v-13h6v19h-14v8h-11zM287 111h-10V95h5v10h5z" />
      </g>
      {variant === "Monitor" ? (
        <g>
          <path
            d="M133 112V56h6v56zm46 0V56h6v56zM128 77h62v5h-62zM138 106l41-30v7l-41 30z"
            fill="#654635"
          />
          <path d="M123 43h66v26h-66zM119 39h74v6h-74z" fill="#986b46" />
          <rect x="132" y="46" width="13" height="15" fill="#3b4232" />
          <rect x="162" y="46" width="15" height="15" fill="#ebc47c" />
          <rect x="153" y="24" width="4" height="16" fill="#4b3b30" />
          <path d="M157 24h20v10h-20z" fill="#e4d09a" />
        </g>
      ) : variant === "记忆与实验" ? (
        <g>
          <path d="M106 109V73h93v36zM110 67h85v7h-85z" fill="#79543a" />
          <rect x="116" y="82" width="32" height="18" fill="#503f30" />
          <path
            d="M163 45h13v5h-3v13l10 8v8h-28v-8l11-8V50h-3z"
            fill="#a8b882"
          />
          <path d="M160 70h18v7h-18z" fill="#566e49" />
          <rect x="118" y="55" width="18" height="13" fill="#d3be85" />
          <rect x="122" y="51" width="10" height="4" fill="#423d2e" />
          <rect x="202" y="64" width="15" height="43" fill="#6b5038" />
          <path d="M143 97h41v4h-41z" fill="#dfb572" />
        </g>
      ) : variant === "通用" ? (
        <g>
          <path d="M102 109l39-56 39 56z" fill="#906244" />
          <path d="M141 53l47 56h-47z" fill="#e0bd7f" />
          <path d="M134 109V81h14v28z" fill="#4d3e30" />
          <rect x="201" y="110" width="28" height="4" fill="#694731" />
          <path d="M209 109v-9h4v-9h5v8h5v10z" fill="#b55739" />
          <rect x="213" y="101" width="5" height="8" fill="#ffdf8e" />
          <path d="M196 63h30v4h-30zm12-9h3v16h-3z" fill="#72573c" />
        </g>
      ) : (
        <g transform={isHome ? "translate(72 8) scale(.85)" : "translate(0 0)"}>
          <rect x="109" y="54" width="93" height="56" fill="#9c7048" />
          <rect x="105" y="50" width="101" height="6" fill="#62452f" />
          <rect x="115" y="35" width="80" height="18" fill="#75503a" />
          <rect x="119" y="38" width="72" height="12" fill="#e4c18b" />
          <text
            x="155"
            y="47"
            textAnchor="middle"
            fontFamily="Silkscreen,monospace"
            fontSize="7"
            fill="#634230"
          >
            {building}
          </text>
          <path d="M104 67h103v10H104z" fill="#ddaa6c" />
          <path
            d="M104 67h12v10h-12zm24 0h12v10h-12zm24 0h12v10h-12zm24 0h12v10h-12zm24 0h7v10h-7z"
            fill="#a65e40"
          />
          <rect x="111" y="77" width="5" height="37" fill="#6a4c33" />
          <rect x="196" y="77" width="5" height="37" fill="#6a4c33" />
          <rect x="142" y="82" width="26" height="28" fill="#453c2c" />
          <rect x="145" y="84" width="9" height="14" fill="#b38d5c" />
          <rect x="157" y="84" width="8" height="14" fill="#b38d5c" />
          <rect x="122" y="83" width="12" height="16" fill="#f1d394" />
          <rect x="177" y="83" width="12" height="16" fill="#f1d394" />
          <rect x="102" y="110" width="108" height="5" fill="#846042" />
          {variant === "飞书" && (
            <g>
              <rect x="218" y="92" width="5" height="23" fill="#61482f" />
              <rect x="211" y="83" width="20" height="12" fill="#636e48" />
              <rect x="214" y="86" width="9" height="2" fill="#e3d29f" />
            </g>
          )}
          {variant === "资源" && (
            <g fill="#805b3b">
              <rect x="80" y="97" width="18" height="17" />
              <rect x="215" y="93" width="17" height="21" />
            </g>
          )}
        </g>
      )}
      {isHome && (
        <g transform="translate(85 64)">
          <path d="M4 11h8V0h19v11h10v5H4z" fill="#49372c" />
          <rect x="12" y="7" width="19" height="4" fill="#d0a26a" />
          <rect x="16" y="16" width="13" height="12" fill="#e0ae76" />
          <rect x="27" y="20" width="2" height="3" fill="#46372a" />
          <path d="M13 28h20v22H10V33h3z" fill="#596344" />
          <path d="M13 28h20v4H22v8h-4v-8h-5z" fill="#a34732" />
          <rect x="7" y="34" width="6" height="20" fill="#596344" />
          <rect x="30" y="33" width="6" height="20" fill="#67704a" />
          <rect x="9" y="48" width="24" height="5" fill="#4a382d" />
          <rect x="18" y="49" width="5" height="3" fill="#debc78" />
          <path d="M12 53h8v17h-13v-5h5zm11 0h8v12h6v5H23z" fill="#4c4233" />
        </g>
      )}
      <g fill="#856546">
        <rect x="251" y="109" width="3" height="19" />
        <rect x="272" y="108" width="3" height="20" />
        <rect x="247" y="112" width="32" height="3" />
        <rect x="247" y="121" width="32" height="3" />
      </g>
    </svg>
  );
}
