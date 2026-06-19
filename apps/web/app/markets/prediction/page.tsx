import { redirect } from "next/navigation";

export default function PredictionMarketsRedirectPage() {
  redirect("/markets/forecast");
}
