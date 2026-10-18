import React, { ReactNode, useEffect, useCallback, useMemo, useState } from "react"
import i18next, { loadTranslations } from "./setup"
import { useGeneralSetting } from "@/hooks/useGeneralSetting"
import { TranslationContext } from "./context"

const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur'])

/** BCP 47 tag for a locale folder name (the app ships Vietnamese as 'vn'). */
const htmlLang = (lng: string): string => (lng === 'vn' ? 'vi' : lng)

// Translation provider component
export const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Get the current language from general settings
	const { currentLanguage } = useGeneralSetting()
	// The language whose strings are loaded and in use. Changing it gives `t`
	// a new identity, so copy memoised on `t` re-renders without a reload.
	const [activeLanguage, setActiveLanguage] = useState(i18next.language)

	// Load translations once when the component mounts
	useEffect(() => {
		try {
			loadTranslations()
		} catch (error) {
			console.error("Failed to load translations:", error)
		}
	}, [])

	// Update language when currentLanguage changes
	useEffect(() => {
		if (currentLanguage) {
			void i18next
				.changeLanguage(currentLanguage)
				.then(() => setActiveLanguage(i18next.language))
		}
	}, [currentLanguage])

	// Screen readers, spell check, hyphenation and Intl date formats read these.
	useEffect(() => {
		document.documentElement.lang = htmlLang(activeLanguage)
		document.documentElement.dir = RTL_LANGUAGES.has(activeLanguage.split('-')[0])
			? 'rtl'
			: 'ltr'
	}, [activeLanguage])

	// Memoize the translation function to prevent unnecessary re-renders
	const translate = useCallback(
		(key: string, options?: Record<string, unknown>) => {
			return i18next.t(key, options)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[activeLanguage],
	)

	const value = useMemo(() => ({ t: translate, i18n: i18next }), [translate])

	return (
		<TranslationContext.Provider value={value}>
			{children}
		</TranslationContext.Provider>
	)
}

export default TranslationProvider
