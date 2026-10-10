import { forwardRef } from 'react';
const Link = forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(
  function Link({ prefetch: _p, ...rest }, ref) {
    return <a ref={ref} {...rest} />;
  }
);
export default Link;
