/**
 * All page selectors live here. If Flipkart ever changes their UI, this is
 * the only file you should need to edit.
 *
 * Each UI target has a PRIMARY and a FALLBACK selector; safeClick/safeFill
 * in utils.js try the primary first and fall back automatically.
 */

const LoginSelectors = {
  LOGIN_BUTTON_XPATH: '//*[@id="app"]/div/div[2]/div/div/div[2]/button[1]',
  LOGIN_BUTTON_FALLBACK: 'button:has-text("Login")',

  EMAIL_INPUT_XPATH:
    '//*[@id="app"]/div[1]/div/section/section/div/div[1]/form/div[1]/div/div[2]/input',
  EMAIL_INPUT_FALLBACK: 'input[type="text"], input[type="email"]',

  NEXT_BUTTON_XPATH:
    '//*[@id="app"]/div[1]/div/section/section/div/div[2]/div[1]/button',
  NEXT_BUTTON_FALLBACK: 'button:has-text("Next")',

  PASSWORD_INPUT_XPATH:
    '//*[@id="app"]/div[1]/div/section/section/div/div[1]/form/div[2]/div/div[2]/input',
  PASSWORD_INPUT_FALLBACK: 'input[type="password"]',

  PASSWORD_SUBMIT_FALLBACK: 'button:has-text("Login"), button[type="submit"]',
};

const WalletSelectors = {
  // Overlays that appear on page load and must be dismissed first.
  MODAL_CLOSE_BUTTON: 'dialog button:has-text("Close")',
  MODAL_CLOSE_XPATH: '//dialog//button[normalize-space()="Close"]',

  TOUR_SKIP_BUTTON: ':text("Skip")',
  TOUR_SKIP_XPATH: '//*[normalize-space()="Skip"]',

  // Date picker trigger — shows "Last 30 days : ..." or "Custom : ...".
  DATE_PICKER_TRIGGER_XPATH: 'div.date[role="presentation"]',
  DATE_PICKER_TRIGGER_FALLBACK:
    '//*[contains(text(), "Last 30 days") or contains(text(), "Custom") ' +
    'or contains(text(), "Yesterday") or contains(text(), "Today")]',

  YESTERDAY_OPTION_XPATH:
    '//li[normalize-space()="Yesterday"]' +
    '|//div[normalize-space()="Yesterday"]' +
    '|//span[normalize-space()="Yesterday"]',
  YESTERDAY_OPTION_FALLBACK: ':text-is("Yesterday")',

  // CUSTOM single-date selection (backfill of a missing past date only).
  // Dual calendar: two consecutive months side by side (LEFT = earlier,
  // RIGHT = later). Inner arrows are inert. Header badges appear in DOM
  // order: [left-month, left-year, right-month, right-year].
  LEFT_CAL_MONTH_BADGE: '(//div[contains(@class, "__HeaderBadge-sc-")])[1]',
  LEFT_CAL_YEAR_BADGE: '(//div[contains(@class, "__HeaderBadge-sc-")])[2]',
  RIGHT_CAL_MONTH_BADGE: '(//div[contains(@class, "__HeaderBadge-sc-")])[3]',
  RIGHT_CAL_YEAR_BADGE: '(//div[contains(@class, "__HeaderBadge-sc-")])[4]',

  LEFT_CAL_PREV_ARROW:
    '(//div[contains(@class, "__HeaderView-sc-")])[1]' +
    '/div[contains(@class, "__Clickable-sc-")][1]',
  RIGHT_CAL_NEXT_ARROW:
    '(//div[contains(@class, "__HeaderView-sc-")])[2]' +
    '/div[contains(@class, "__Clickable-sc-")][last()]',

  CUSTOM_DONE_XPATH: '//div[contains(@class, "__DoneButton-sc-")]',
  CUSTOM_DONE_FALLBACK: ':text-is("Done")',

  dayCellXPath(day, calIndex) {
    return (
      `(//table[contains(@class, "__MonthWrapper-sc-")])[${calIndex}]` +
      `//td[contains(@class, "__Day-sc-") ` +
      `and not(contains(@class, "disabled")) ` +
      `and normalize-space()="${day}"]`
    );
  },

  // Download icon — the small downward arrow next to the date display.
  DOWNLOAD_ICON_XPATH:
    '//*[contains(text(), "Last 30 days") or contains(text(), "Custom")]' +
    '[contains(text(), "-")]/following-sibling::*[1]',
  DOWNLOAD_ICON_FALLBACK:
    '[class*="download"], [aria-label*="download"], ' +
    '[title*="Download"], [title*="download"]',
};

module.exports = { LoginSelectors, WalletSelectors };
