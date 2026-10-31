/** Copy-to-clipboard button state with temporary confirmation feedback. */
import { useState, useCallback } from 'react';
import { LinkIcon, CheckIcon } from '@heroicons/react/20/solid';

export function useLinkSharing() {
  const [isLinkCopied, setIsLinkCopied] = useState(false);

  const handleLinkClick = useCallback(() => {
    setIsLinkCopied(true);
    setTimeout(() => setIsLinkCopied(false), 2500);
  }, []);

  const icon = isLinkCopied ? CheckIcon : LinkIcon;
  const label = isLinkCopied ? 'Link copied' : 'Link sharing';

  return {
    icon,
    label,
    handleLinkClick,
  };
}
