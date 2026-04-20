export const PERSONAL_DETAILS_BLUR_CLASS = "blur-sm select-none";

export function getPersonalDetailsBlurClass(blurPersonalData: boolean): string {
  return blurPersonalData ? PERSONAL_DETAILS_BLUR_CLASS : "";
}

export function shouldBlurEmailMention(input: {
  blurPersonalData: boolean;
  email: string | null | undefined;
  text: string | null | undefined;
}): boolean {
  const email = input.email?.trim() ?? "";
  const text = input.text ?? "";
  return input.blurPersonalData && email.length > 0 && text.includes(email);
}
